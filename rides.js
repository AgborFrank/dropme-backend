const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Request a Ride
router.post('/request', async (req, res) => {
  const { riderId, pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;
  try {
    const { data: ride, error } = await supabase
      .from('rides')
      .insert([{
        rider_id: riderId,
        pickup_location: { type: 'Point', coordinates: [pickupLng, pickupLat] },
        dropoff_location: { type: 'Point', coordinates: [dropoffLng, dropoffLat] },
      }])
      .select()
      .single();
    if (error) throw error;

    // Find nearby drivers (~5km)
    const { data: drivers, error: driverError } = await supabase
      .rpc('nearby_drivers', {
        lat: pickupLat,
        lng: pickupLng,
        max_distance: 5000, // meters
      });
    if (driverError) throw driverError;

    // Notify drivers via Socket.IO
    drivers.forEach((driver) =>
      io.to(driver.id).emit('rideRequest', {
        rideId: ride.id,
        pickupLocation: { lat: pickupLat, lng: pickupLng },
      })
    );

    res.status(201).json({ message: 'Ride requested', rideId: ride.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Accept a Ride (Driver)
router.post('/accept', async (req, res) => {
  const { rideId, driverId } = req.body;
  try {
    const { data: ride, error } = await supabase
      .from('rides')
      .update({ driver_id: driverId, status: 'accepted' })
      .eq('id', rideId)
      .eq('status', 'requested')
      .select()
      .single();
    if (error || !ride) throw error || new Error('Invalid ride');

    io.to(ride.rider_id).emit('rideAccepted', { rideId, driverId });
    res.json({ message: 'Ride accepted' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get Nearby Vehicles
router.get('/nearby', async (req, res) => {
    const { lat, lng } = req.query;
    try {
      const { data: drivers, error } = await supabase
        .rpc('nearby_drivers', {
          lat: parseFloat(lat),
          lng: parseFloat(lng),
          max_distance: 5000, // 5km
        });
      if (error) throw error;
  
      res.json(drivers.map((d) => ({ id: d.id, location: d.location })));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

module.exports = router;