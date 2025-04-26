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
          coordinates: businessData.coordinates, // JSONB field for { latitude, longitude }
          contact: businessData.contact || null, // Optional
          logo: businessData.logo || null, // Optional
          description: businessData.description || null, // Optional
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