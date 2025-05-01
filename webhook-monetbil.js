const express = require('express');
const md5 = require('md5');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook Endpoint for Monetbil Callback
app.post('/webhook/monetbil', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Received Monetbil callback:', JSON.stringify(payload, null, 2));
    console.log('Request headers:', req.headers);

    const { payment_ref, status, transaction_id, amount, currency, fee, message, operator, sign, service } = payload;

    if (!payment_ref || !status) {
      console.error('Missing required fields in callback:', { payment_ref, status });
      return res.status(400).json({ error: 'Missing payment_ref or status' });
    }

    const SERVICE_KEY = process.env.SERVICE_KEY || "M55rSvthtYGRYp1Nl81o4W9xVUynS97X";
    const dataToSign = `${service}${transaction_id}${amount}${currency}${status}${payment_ref}${SERVICE_KEY}`;
    console.log('Signature data:', { service, transaction_id, amount, currency, status, payment_ref, SERVICE_KEY });
    const computedSign = md5(dataToSign);
    console.log('Computed sign:', computedSign, 'Received sign:', sign);

    if (computedSign !== sign) {
      console.error('Invalid signature:', { computedSign, receivedSign: sign });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let dbStatus;
    switch (status.toUpperCase()) {
      case 'SUCCESSFUL':
      case 'SUCCESS':
        dbStatus = 'completed';
        break;
      case 'FAILED':
      case 'CANCELLED':
        dbStatus = 'failed';
        break;
      case 'PENDING':
        dbStatus = 'pending';
        break;
      default:
        console.warn('Unknown Monetbil status:', status);
        dbStatus = 'failed';
    }

    const supabase = req.supabase;
    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('id, user_id, amount, status')
      .eq('payment_ref', payment_ref)
      .single();

    if (fetchError || !transaction) {
      console.error('Transaction fetch error:', fetchError?.message, fetchError?.details);
      return res.status(404).json({ error: 'Transaction not found', details: fetchError?.message });
    }

    console.log('Found transaction:', transaction);

    if (['completed', 'failed'].includes(transaction.status)) {
      console.warn(`Transaction ${payment_ref} already processed with status: ${transaction.status}`);
      return res.status(200).json({ success: true, message: 'Transaction already processed', payment_ref, status: transaction.status });
    }

    const transactionUpdate = {
      status: dbStatus,
      updated_at: new Date().toISOString(),
      charge: parseFloat(fee || 0),
      method: `Monetbil (${operator || 'Unknown Operator'})`,
      description: `Deposit via Mobile Money (Monetbil) - ${message || 'No message provided'}`
    };

    const { data: updatedTransaction, error: updateTransactionError } = await supabase
      .from('transactions')
      .update(transactionUpdate)
      .eq('payment_ref', payment_ref)
      .select()
      .single();

    if (updateTransactionError) {
      console.error('Transaction update failed:', updateTransactionError.message, updateTransactionError.details);
      return res.status(500).json({ error: 'Failed to update transaction', details: updateTransactionError.message });
    }

    console.log('Transaction updated:', updatedTransaction);

    if (dbStatus === 'completed') {
      const netAmount = parseFloat(amount) - parseFloat(fee || 0);

      const { data: wallet, error: fetchWalletError } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', transaction.user_id)
        .single();

      if (fetchWalletError || !wallet) {
        console.error('Wallet fetch error:', fetchWalletError?.message, fetchWalletError?.details);
        await supabase
          .from('transactions')
          .update({ status: 'failed', description: 'Deposit failed - Wallet not found', updated_at: new Date().toISOString() })
          .eq('payment_ref', payment_ref);
        return res.status(500).json({ error: 'Wallet not found', details: fetchWalletError?.message });
      }

      console.log('Current wallet:', wallet);

      const newBalance = parseFloat(wallet.balance || 0) + netAmount;
      const { data: updatedWallet, error: updateWalletError } = await supabase
        .from('wallets')
        .update({
          balance: newBalance,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', transaction.user_id)
        .select()
        .single();

      if (updateWalletError) {
        console.error('Wallet update failed:', updateWalletError.message, updateWalletError.details);
        await supabase
          .from('transactions')
          .update({ status: 'failed', description: 'Deposit failed - Could not update wallet balance', updated_at: new Date().toISOString() })
          .eq('payment_ref', payment_ref);
        return res.status(500).json({ error: 'Failed to update wallet balance', details: updateWalletError.message });
      }

      console.log(`Wallet updated for user ${transaction.user_id}: New balance = ${newBalance}`, updatedWallet);
    }

    // Emit Socket.IO event for real-time update
    const io = req.app.get('io');
    io.to(transaction.user_id).emit('transaction_update', { payment_ref, status: dbStatus });

    console.log(`Transaction ${payment_ref} updated to status: ${dbStatus}`);
    return res.status(200).json({ success: true, payment_ref, status: dbStatus });
  } catch (error) {
    console.error('Error processing callback:', error.message, error.stack);
    throw error; // Let global error handler catch this
  }
});

// Endpoint to check payment status manually
app.post('/api/check-payment', async (req, res) => {
  try {
    const { payment_ref, transaction_id } = req.body;

    if (!payment_ref) {
      return res.status(400).json({ error: 'Missing payment_ref' });
    }

    console.log('Checking payment status for:', { payment_ref, transaction_id });

    const supabase = req.supabase;
    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('id, user_id, amount, status, payment_ref, transaction_id')
      .eq('payment_ref', payment_ref)
      .single();

    if (fetchError || !transaction) {
      console.error('Transaction fetch error:', fetchError?.message, fetchError?.details);
      return res.status(404).json({ error: 'Transaction not found', details: fetchError?.message });
    }

    if (['completed', 'failed'].includes(transaction.status)) {
      console.log(`Transaction ${payment_ref} already processed with status: ${transaction.status}`);
      return res.status(200).json({ status: transaction.status, message: transaction.description });
    }

    const SERVICE_KEY = process.env.SERVICE_KEY || "M55rSvthtYGRYp1Nl81o4W9xVUynS97X";
    const checkPaymentUrl = `https://api.monetbil.com/v2.1/check/${SERVICE_KEY}`;
    const paymentId = transaction_id || transaction.transaction_id || payment_ref;

    console.log('Checking Monetbil payment status:', { checkPaymentUrl, paymentId });

    const response = await fetch(checkPaymentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ transaction_id: paymentId }).toString(),
    });

    console.log('Monetbil checkPayment response status:', response.status);
    console.log('Monetbil checkPayment response headers:', response.headers);

    const rawResponse = await response.text();
    console.log('Monetbil checkPayment raw response:', rawResponse);

    if (!response.ok) {
      return res.status(500).json({ error: `Monetbil API error: ${response.status}`, details: rawResponse });
    }

    let result;
    try {
      result = JSON.parse(rawResponse);
    } catch (parseError) {
      console.error('Failed to parse Monetbil response as JSON:', parseError.message);
      return res.status(500).json({ error: 'Invalid response from Monetbil', details: rawResponse });
    }

    console.log('Monetbil checkPayment parsed response:', result);

    if (!result || !result.status) {
      return res.status(500).json({ error: 'Failed to check payment status with Monetbil', details: result });
    }

    let dbStatus;
    switch (result.status.toUpperCase()) {
      case 'SUCCESSFUL':
      case 'SUCCESS':
        dbStatus = 'completed';
        break;
      case 'FAILED':
      case 'CANCELLED':
        dbStatus = 'failed';
        break;
      case 'PENDING':
        dbStatus = 'pending';
        break;
      default:
        console.warn('Unknown Monetbil status:', result.status);
        dbStatus = 'failed';
    }

    const transactionUpdate = {
      status: dbStatus,
      updated_at: new Date().toISOString(),
      description: `Status updated via polling - ${result.message || 'No message provided'}`
    };

    const { error: updateTransactionError } = await supabase
      .from('transactions')
      .update(transactionUpdate)
      .eq('payment_ref', payment_ref);

    if (updateTransactionError) {
      console.error('Transaction update failed:', updateTransactionError.message, updateTransactionError.details);
      return res.status(500).json({ error: 'Failed to update transaction', details: updateTransactionError.message });
    }

    if (dbStatus === 'completed') {
      const netAmount = parseFloat(result.amount || transaction.amount) - parseFloat(result.fee || 0);

      const { data: wallet, error: fetchWalletError } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', transaction.user_id)
        .single();

      if (fetchWalletError || !wallet) {
        console.error('Wallet fetch error:', fetchWalletError?.message, fetchWalletError?.details);
        await supabase
          .from('transactions')
          .update({ status: 'failed', description: 'Deposit failed - Wallet not found', updated_at: new Date().toISOString() })
          .eq('payment_ref', payment_ref);
        return res.status(500).json({ error: 'Wallet not found', details: fetchWalletError?.message });
      }

      const newBalance = parseFloat(wallet.balance || 0) + netAmount;
      const { error: updateWalletError } = await supabase
        .from('wallets')
        .update({
          balance: newBalance,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', transaction.user_id);

      if (updateWalletError) {
        console.error('Wallet update failed:', updateWalletError.message, updateWalletError.details);
        await supabase
          .from('transactions')
          .update({ status: 'failed', description: 'Deposit failed - Could not update wallet balance', updated_at: new Date().toISOString() })
          .eq('payment_ref', payment_ref);
        return res.status(500).json({ error: 'Failed to update wallet balance', details: updateWalletError.message });
      }

      console.log(`Wallet updated for user ${transaction.user_id}: New balance = ${newBalance}`);
    }

    // Emit Socket.IO event for real-time update
    const io = req.app.get('io');
    io.to(transaction.user_id).emit('transaction_update', { payment_ref, status: dbStatus });

    console.log(`Transaction ${payment_ref} updated to status: ${dbStatus} via polling`);
    return res.status(200).json({ status: dbStatus, message: result.message || 'Status checked successfully' });
  } catch (error) {
    console.error('Error checking payment status:', error.message, error.stack);
    throw error; // Let global error handler catch this
  }
});

module.exports = app;