const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const http = require('http');
const authRoutes = require('./auth'); // Adjust path if needed
const rideRoutes = require('./rides'); // Adjust path if needed

console.log('Starting server...');
require('dotenv').config();
console.log('Dotenv config loaded');

// Debug environment variables
console.log('Environment variables:', {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
});

const app = express();
console.log('Express app created');
const server = http.createServer(app);
const allowedOrigins = [
  'http://localhost:3000',
  process.env.EXPO_APP_URL || 'exp://.*', // Allow all Expo tunnel URLs
  'https://dropme-backend.onrender.com'  // Your Render URL
].filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
}));

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
console.log(supabase);

app.use(helmet());
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rides', rideRoutes);
app.get('/', (req, res) => res.send('Car Hailing Backend'));

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('updateLocation', async (data) => {
    console.log('Received updateLocation:', data);
    const { userId, lat, lng, userType } = data;

    try {
      // Validate role
      const validRole = userType === 'driver' || userType === 'rider' ? userType : 'rider'; // Default to rider if invalid
      const point = `POINT(${lng} ${lat})`;

      const { error } = await supabase
        .from('user_locations') // Updated table name
        .upsert(
          {
            user_id: userId,
            location: point,
            userType: validRole,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' } // Update if user_id already exists
        );

      if (error) {
        console.error('Supabase insert error:', error);
        throw error;
      }

      console.log(`Saved location for ${validRole} ${userId}`);
    } catch (err) {
      console.error('Unexpected error:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});


socket.on('requestNearbyDrivers', async (riderData) => {
  const { userId: riderId, lat, lng } = riderData;
  const riderPoint = `POINT(${lng} ${lat})`;

  // Save rider location
  await supabase.from('user_locations').upsert({
    user_id: riderId,
    location: riderPoint,
    userType: 'rider',
    updated_at: new Date().toISOString(),
  });

  // Fetch nearby drivers (within 10km, example)
  const { data, error } = await supabase
    .from('user_locations')
    .select('user_id, location')
    .eq('userType', 'driver')
    .not('user_id', 'eq', riderId) // Exclude the rider
    .lt('updated_at', new Date(Date.now() - 5 * 60 * 1000)) // Only recent locations (last 5 mins)
    .select(`*, distance:st_distance(location, ST_GeomFromText('${riderPoint}', 4326))`)
    .lte('distance', 10000); // 10km radius

  if (error) {
    console.error('Error fetching drivers:', error);
    return;
  }

  socket.emit('nearbyDrivers', data);
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});
// Error Handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something went wrong!');
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));