const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const http = require('http');
const authRoutes = require('./auth'); // Adjust path if needed
const rideRoutes = require('./rides'); // Adjust path if needed

require('dotenv').config();
console.log('Starting server...');

// Ensure required environment variables are set
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  'http://localhost:3000',
  process.env.EXPO_APP_URL || 'exp://.*', // Allow all Expo tunnel URLs
  'https://dropme-backend-s7wz.onrender.com'  // Your Render URL
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
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 })); // 60 requests per minute

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
console.log('Supabase client initialized');

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rides', rideRoutes);
app.get('/', (req, res) => res.send('Car Hailing Backend'));

// Socket.IO setup
const io = new Server(server, {
  cors: corsOptions,
});
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('updateLocation', async (data) => {
    console.log('Received updateLocation:', data);
    const { userId, lat, lng, role } = data;

    try {
      if (!userId || isNaN(lat) || isNaN(lng)) {
        throw new Error('Invalid updateLocation data');
      }

      const validRole = role === 'driver' || role === 'rider' ? role : 'rider';
      const point = `POINT(${lng} ${lat})`; // longitude first, then latitude

      const { error } = await supabase
        .from('user_locations')
        .upsert(
          {
            user_id: userId,
            location: point,
            role: validRole,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );

      if (error) {
        console.error('Supabase upsert error:', error);
        throw error;
      }

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

      const riderPoint = `POINT(${lng} ${lat})`;

      const { error: upsertError } = await supabase
        .from('user_locations')
        .upsert({
          user_id: riderId,
          location: riderPoint,
          role: 'rider',
          updated_at: new Date().toISOString(),
        });

      if (upsertError) {
        throw upsertError;
      }

      const { data, error } = await supabase
        .from('user_locations')
        .select('user_id, location')
        .eq('role', 'driver')
        .not('user_id', 'eq', riderId)
        .gt('updated_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
        .select(`*, distance:st_distance(location, ST_GeomFromText('${riderPoint}', 4326))`)
        .lte('distance', 10000);

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

  socket.on('getDriverStatus', (data) => {
    const { driverId } = data;
    const { data } = await supabase.from('drivers').select('status').eq('id', driverId).single();
    const status = 'offline'; // Replace with actual DB fetch
    socket.emit('driverStatus', { driverId, status });
  });

  socket.on('updateDriverStatus', (data) => {
    const { driverId, status } = data;
    console.log(`Driver ${driverId} set to ${status}`);
    await supabase.from('drivers').update({ status }).eq('id', driverId);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});


// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something went wrong!');
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));