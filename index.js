const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const http = require('http');
const authRoutes = require('./auth');
const rideRoutes = require('./rides');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();
console.log('Starting server...');

// Validate environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_KEY', 'PORT'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const allowedOrigins = [
  'http://localhost:3000',
  process.env.EXPO_APP_URL || 'exp://.*',
  'https://dropme-backend-s7wz.onrender.com'
].filter(Boolean);

// CORS Configuration
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some((o) => origin.startsWith(o))) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
};

app.use(cors(corsOptions));
app.use(helmet());
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
console.log('Supabase client initialized');

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rides', rideRoutes);
app.get('/', (req, res) => res.send('Car Hailing Backend'));

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('updateLocation', async (data) => {
    console.log('Received updateLocation:', data);
    const { userId, lat, lng, role } = data;
    try {
      if (!userId || isNaN(lat) || isNaN(lng)) {
        throw new Error('Invalid updateLocation data');
      }
      const validRole = ['driver', 'rider'].includes(role) ? role : 'rider';
      const { error } = await supabase
        .rpc('upsert_user_location', {
          p_user_id: userId,
          p_lat: lat,
          p_lng: lng,
          p_role: validRole,
          p_updated_at: new Date().toISOString(),
        });
      if (error) throw error;
      console.log(`Saved location for ${validRole} ${userId}`);
    } catch (err) {
      console.error('Unexpected error in updateLocation:', err.message);
    }
  });

  socket.on('requestNearbyDrivers', async (riderData) => {
    console.log('Received requestNearbyDrivers:', riderData);
    const { userId: riderId, lat, lng } = riderData;
    try {
      if (!riderId || isNaN(lat) || isNaN(lng)) {
        throw new Error('Invalid riderData');
      }
      const { error: upsertError } = await supabase
        .rpc('upsert_user_location', {
          p_user_id: riderId,
          p_lat: lat,
          p_lng: lng,
          p_role: 'rider',
          p_updated_at: new Date().toISOString(),
        });
      if (upsertError) throw upsertError;
      const { data, error } = await supabase.rpc('nearby_drivers', {
        lat: lat,
        lng: lng,
        max_distance: 5000,
      });
      if (error) {
        console.error('Error fetching drivers:', error);
        throw error;
      }
      socket.emit('nearbyDrivers', data);
      console.log('Sent nearbyDrivers:', data);
    } catch (err) {
      console.error('Error in requestNearbyDrivers:', err.message);
    }
  });

  socket.on('newRideRequest', async (request) => {
    try {
      const rideRequest = {
        id: uuidv4(),
        passenger: request.passenger || "John Doe",
        rating: request.rating || 4.8,
        pickup: request.pickup || { lat: 37.78825, lng: -122.4324, location: "Downtown" },
        dropoff: request.dropoff || { lat: 37.6213, lng: -122.3790, location: "Airport" },
        fare: request.fare || 25,
        eta: request.eta || 7,
        rider_id: request.rider_id,
        status: 'pending',
        created_at: new Date().toISOString(),
        ridetype: request.rideType,
        booking_date: request.bookingDate || null,
        passenger_count: request.passengerCount || 1,
      };

      const { error } = await supabase
        .from('ride_requests')
        .insert(rideRequest);

      if (error) {
        console.error('Error saving ride request:', error);
        throw error;
      }

      io.emit('rideRequest', rideRequest);
      console.log('Emitted rideRequest:', rideRequest);
    } catch (err) {
      console.error('Error in newRideRequest:', err.message);
    }
  });

  socket.on('acceptRide', async (data) => {
    const { driverId, requestId } = data;
    try {
      if (!driverId || !requestId) {
        throw new Error('Invalid acceptRide data');
      }

      const response = await fetch(`${BACKEND_URL}/api/rides/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, driverId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to confirm ride');
      }

      const { ride } = await response.json();
      const tripUpdate = {
        id: requestId,
        driverId,
        rider_id: ride.rider_id,
        pickup: ride.pickup_location,
        dropoff: ride.dropoff_location,
        fare: ride.fare,
        status: 'accepted',
        booking_date: ride.booking_date,
        passenger_count: ride.passenger_count,
      };

      io.emit('tripUpdate', tripUpdate);
      console.log('Emitted tripUpdate:', tripUpdate);
    } catch (err) {
      console.error('Error in acceptRide:', err.message);
    }
  });

  socket.on('declineRide', async (data) => {
    const { driverId, requestId } = data;
    try {
      if (!driverId || !requestId) {
        throw new Error('Invalid declineRide data');
      }

      const { error } = await supabase
        .from('ride_requests')
        .update({ status: 'declined' })
        .eq('id', requestId);

      if (error) {
        console.error('Error declining ride request:', error);
        throw error;
      }

      console.log(`Ride ${requestId} declined by driver ${driverId}`);
    } catch (err) {
      console.error('Error in declineRide:', err.message);
    }
  });

  socket.on('getDriverStatus', async (data) => {
    const { driverId } = data;
    try {
      const { data: driverData, error } = await supabase
        .from('drivers')
        .select('status')
        .eq('id', driverId)
        .single();

      if (error) {
        console.error('Error fetching driver status:', error);
        throw error;
      }

      const status = driverData?.status || 'offline';
      socket.emit('driverStatus', { driverId, status });
      console.log(`Sent status ${status} for driver ${driverId}`);
    } catch (err) {
      console.error('Error in getDriverStatus:', err.message);
      socket.emit('driverStatus', { driverId, status: 'offline' });
    }
  });

  socket.on('updateDriverStatus', async (data) => {
    const { driverId, status } = data;
    try {
      const { error } = await supabase
        .from('drivers')
        .upsert(
          {
            id: driverId,
            status: status,
          },
          { onConflict: 'id' }
        );

      if (error) {
        console.error('Error upserting driver status:', error);
        throw error;
      }

      console.log(`Driver ${driverId} set to ${status}`);
    } catch (err) {
      console.error('Error in updateDriverStatus:', err.message);
    }
  });

  //Business Creation Logic
 
 
  socket.on('createBusiness', async (businessData) => {
    try {
      // Validate required fields
      if (!businessData.id || !businessData.ownerId || !businessData.name || !businessData.category || !businessData.address || !businessData.coordinates) {
        socket.emit('error', 'Missing required fields');
        return;
      }

      // Insert business data into Supabase
      const { data, error } = await supabase
        .from('businesses')
        .insert([{
          id: businessData.id,
          owner_id: businessData.ownerId,
          name: businessData.name,
          category: businessData.category,
          address: businessData.address,
          coordinates: businessData.coordinates,
          contact: businessData.contact || null,
          logo: businessData.logo || null,
          description: businessData.description || null,
        }])
        .select()
        .single();

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to create business: ' + error.message);
        return;
      }

      console.log('Business created:', data);
      socket.emit('businessCreated', { businessId: data.id });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('addItem', async (itemData) => {
    try {
      // Validate required fields
      if (!itemData.id || !itemData.businessId || !itemData.name || !itemData.price) {
        socket.emit('error', 'Missing required fields for item');
        return;
      }

      // Insert item data into Supabase
      const { data, error } = await supabase
        .from('items')
        .insert([{
          id: itemData.id,
          business_id: itemData.businessId,
          name: itemData.name,
          price: itemData.price,
          image: itemData.image || null,
          description: itemData.description || null,
        }])
        .select()
        .single();

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to add item: ' + error.message);
        return;
      }

      console.log('Item added:', data);
      socket.emit('itemAdded', { itemId: data.id });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('editItem', async (itemData) => {
    try {
      // Validate required fields
      if (!itemData.itemId || !itemData.businessId) {
        socket.emit('error', 'Missing required fields for editing item');
        return;
      }

      // Verify the item exists and belongs to the business
      const { data: existingItem, error: fetchError } = await supabase
        .from('items')
        .select('*')
        .eq('id', itemData.itemId)
        .eq('business_id', itemData.businessId)
        .single();

      if (fetchError || !existingItem) {
        console.error('Supabase error:', fetchError);
        socket.emit('error', 'Item not found or does not belong to this business');
        return;
      }

      // Update item data in Supabase
      const { data, error } = await supabase
        .from('items')
        .update({
          name: itemData.name || existingItem.name,
          price: itemData.price || existingItem.price,
          image: itemData.image !== undefined ? itemData.image : existingItem.image,
          description: itemData.description !== undefined ? itemData.description : existingItem.description,
        })
        .eq('id', itemData.itemId)
        .select()
        .single();

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to edit item: ' + error.message);
        return;
      }

      console.log('Item edited:', data);
      socket.emit('itemEdited', { itemId: data.id });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('deleteItem', async (itemData) => {
    try {
      // Validate required fields
      if (!itemData.itemId || !itemData.businessId) {
        socket.emit('error', 'Missing required fields for deleting item');
        return;
      }

      // Verify the item exists and belongs to the business
      const { data: existingItem, error: fetchError } = await supabase
        .from('items')
        .select('*')
        .eq('id', itemData.itemId)
        .eq('business_id', itemData.businessId)
        .single();

      if (fetchError || !existingItem) {
        console.error('Supabase error:', fetchError);
        socket.emit('error', 'Item not found or does not belong to this business');
        return;
      }

      // Delete item from Supabase
      const { error } = await supabase
        .from('items')
        .delete()
        .eq('id', itemData.itemId);

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to delete item: ' + error.message);
        return;
      }

      console.log('Item deleted:', itemData.itemId);
      socket.emit('itemDeleted', { itemId: itemData.itemId });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('fetchItems', async (data) => {
    try {
      // Validate required fields
      if (!data.businessId) {
        socket.emit('error', 'Missing business ID');
        return;
      }

      // Fetch items for the business from Supabase
      const { data: items, error } = await supabase
        .from('items')
        .select('*')
        .eq('business_id', data.businessId);

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to fetch items: ' + error.message);
        return;
      }

      console.log('Items fetched:', items);
      socket.emit('itemsFetched', { items: items || [] });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('fetchOrders', async (data) => {
    try {
      if (!data.businessId) {
        socket.emit('error', 'Missing business ID');
        return;
      }

      const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select('*')
        .eq('business_id', data.businessId);

      if (ordersError) {
        console.error('Supabase error:', ordersError);
        socket.emit('error', 'Failed to fetch orders: ' + ordersError.message);
        return;
      }

      const orderIds = orders.map(order => order.id);
      const { data: orderItems, error: itemsError } = await supabase
        .from('order_items')
        .select('*')
        .in('order_id', orderIds);

      if (itemsError) {
        console.error('Supabase error:', itemsError);
        socket.emit('error', 'Failed to fetch order items: ' + itemsError.message);
        return;
      }

      const ordersWithItems = orders.map(order => ({
        ...order,
        items: orderItems.filter(item => item.order_id === order.id),
      }));

      console.log('Orders fetched:', ordersWithItems);
      socket.emit('ordersFetched', { orders: ordersWithItems });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('updateOrderStatus', async (data) => {
    try {
      if (!data.orderId || !data.businessId || !data.status) {
        socket.emit('error', 'Missing required fields for updating order status');
        return;
      }

      const { data: existingOrder, error: fetchError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', data.orderId)
        .eq('business_id', data.businessId)
        .single();

      if (fetchError || !existingOrder) {
        console.error('Supabase error:', fetchError);
        socket.emit('error', 'Order not found or does not belong to this business');
        return;
      }

      const { data, error } = await supabase
        .from('orders')
        .update({ status: data.status })
        .eq('id', data.orderId)
        .select()
        .single();

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to update order status: ' + error.message);
        return;
      }

      console.log('Order status updated:', data);
      socket.emit('orderStatusUpdated', { orderId: data.id, status: data.status });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('fetchRestaurants', async (data) => {
    try {
      if (!data.category) {
        socket.emit('error', 'Missing category');
        return;
      }

      // Fetch restaurants by category
      const { data: businesses, error: businessError } = await supabase
        .from('businesses')
        .select('*')
        .eq('category', data.category);

      if (businessError) {
        console.error('Supabase error:', businessError);
        socket.emit('error', 'Failed to fetch restaurants: ' + businessError.message);
        return;
      }

      // Fetch items for each restaurant
      const businessIds = businesses.map(business => business.id);
      const { data: items, error: itemsError } = await supabase
        .from('items')
        .select('*')
        .in('business_id', businessIds);

      if (itemsError) {
        console.error('Supabase error:', itemsError);
        socket.emit('error', 'Failed to fetch items: ' + itemsError.message);
        return;
      }

      // Combine businesses with their items
      const restaurants = businesses.map(business => ({
        id: business.id,
        name: business.name,
        address: business.address,
        coordinates: business.coordinates,
        items: items.filter(item => item.business_id === business.id),
      }));

      console.log('Restaurants fetched:', restaurants);
      socket.emit('restaurantsFetched', { restaurants });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('fetchRestaurants', async (data) => {
    try {
      if (!data.category) {
        socket.emit('error', 'Missing category');
        return;
      }

      // Fetch restaurants by category
      const { data: businesses, error: businessError } = await supabase
        .from('businesses')
        .select('*')
        .eq('category', data.category);

      if (businessError) {
        console.error('Supabase error:', businessError);
        socket.emit('error', 'Failed to fetch restaurants: ' + businessError.message);
        return;
      }

      // Fetch items for each restaurant
      const businessIds = businesses.map(business => business.id);
      const { data: items, error: itemsError } = await supabase
        .from('items')
        .select('*')
        .in('business_id', businessIds);

      if (itemsError) {
        console.error('Supabase error:', itemsError);
        socket.emit('error', 'Failed to fetch items: ' + itemsError.message);
        return;
      }

      // Combine businesses with their items
      const restaurants = businesses.map(business => ({
        id: business.id,
        name: business.name,
        address: business.address,
        coordinates: business.coordinates,
        items: items.filter(item => item.business_id === business.id),
      }));

      console.log('Restaurants fetched:', restaurants);
      socket.emit('restaurantsFetched', { restaurants });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('placeOrder', async (orderData) => {
    try {
      if (!orderData.id || !orderData.businessId || !orderData.customerId || !orderData.customerName || !orderData.totalPrice || !orderData.items) {
        socket.emit('error', 'Missing required fields for placing order');
        return;
      }

      // Insert order
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert([{
          id: orderData.id,
          business_id: orderData.businessId,
          customer_id: orderData.customerId,
          customer_name: orderData.customerName,
          total_price: orderData.totalPrice,
          status: 'Pending',
        }])
        .select()
        .single();

      if (orderError) {
        console.error('Supabase error:', orderError);
        socket.emit('error', 'Failed to place order: ' + orderError.message);
        return;
      }

      // Insert order items
      const orderItems = orderData.items.map(item => ({
        id: item.id,
        order_id: orderData.id,
        item_id: item.itemId,
        item_name: item.itemName,
        quantity: item.quantity,
        price: item.price,
      }));

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(orderItems);

      if (itemsError) {
        console.error('Supabase error:', itemsError);
        socket.emit('error', 'Failed to save order items: ' + itemsError.message);
        return;
      }

      console.log('Order placed:', order);
      socket.emit('orderPlaced', { orderId: order.id });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });
  socket.on('fetchPharmacies', async (data) => {
    try {
      if (!data.category) {
        socket.emit('error', 'Missing category');
        return;
      }

      // Fetch pharmacies by category
      const { data: businesses, error: businessError } = await supabase
        .from('businesses')
        .select('*')
        .eq('category', data.category);

      if (businessError) {
        console.error('Supabase error:', businessError);
        socket.emit('error', 'Failed to fetch pharmacies: ' + businessError.message);
        return;
      }

      // Fetch items for each pharmacy
      const businessIds = businesses.map(business => business.id);
      const { data: items, error: itemsError } = await supabase
        .from('items')
        .select('*')
        .in('business_id', businessIds);

      if (itemsError) {
        console.error('Supabase error:', itemsError);
        socket.emit('error', 'Failed to fetch items: ' + itemsError.message);
        return;
      }

      // Combine businesses with their items
      const pharmacies = businesses.map(business => ({
        id: business.id,
        name: business.name,
        address: business.address,
        coordinates: business.coordinates,
        items: items.filter(item => item.business_id === business.id),
      }));

      console.log('Pharmacies fetched:', pharmacies);
      socket.emit('pharmaciesFetched', { pharmacies });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('fetchSliderImages', async (data) => {
    try {
      if (!data.category) {
        socket.emit('error', 'Missing category for slider images');
        return;
      }

      const { data: images, error } = await supabase
        .from('slider_images')
        .select('id, image_url, category')
        .eq('category', data.category);

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to fetch slider images: ' + error.message);
        return;
      }

      console.log('Slider images fetched:', images);
      socket.emit('sliderImagesFetched', { images: images || [] });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));