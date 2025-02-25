require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Debug environment variables
console.log('Auth.js - Environment variables:', {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
});

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);


// Register (called after Supabase Auth signup)
router.post('/register', async (req, res) => {
  const { userId, first_name, last_name, email, role } = req.body;
  try {
    const { data, error } = await supabase
      .from('users')
      .insert([{ id: userId, first_name, last_name, email, role }]);
    if (error) throw error;
    res.status(201).json({ message: 'User registered', userId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Note: Login is handled by Supabase Auth directly via the client SDK
module.exports = router;