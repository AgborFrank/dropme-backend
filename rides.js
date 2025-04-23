const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

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

// Confirm a Ride Request (Transition ride_requests to rides)
router.post('/confirm', async (req, res) => {
  const { requestId, driverId } = req.body;
  try {
    if (!requestId || !driverId) {
      throw new Error('Missing requestId or driverId');
    }

    // Fetch the ride request
    const { data: request, error: requestError } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('id', requestId)
      .eq('status', 'pending')
      .single();
    if (requestError || !request) {
      throw requestError || new Error('Invalid or non-pending ride request');
    }

    // Update ride_requests to accepted
    const { error: updateError } = await supabase
      .from('ride_requests')
      .update({ status: 'accepted', driver_id: driverId })
      .eq('id', requestId);
    if (updateError) throw updateError;

    // Create a new rides entry
    const ride = {
      id: uuidv4(),
      rider_id: request.rider_id,
      driver_id: driverId,
      pickup_location: {
        type: 'Point',
        coordinates: [request.pickup.lng, request.pickup.lat]
      },
      dropoff_location: {
        type: 'Point',
        coordinates: [request.dropoff.lng, request.dropoff.lat]
      },
      status: 'accepted',
      fare: request.fare,
    };

    const { data: newRide, error: rideError } = await supabase
      .from('rides')
      .insert([ride])
      .select()
      .single();
    if (rideError) throw rideError;

    res.status(200).json({ message: 'Ride confirmed', ride: newRide });
  } catch (error) {
    console.error('Error in confirm ride:', error.message);
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
        max_distance: 5000,
      });
    if (error) throw error;

    res.json(drivers.map((d) => ({ id: d.id, location: d.location })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;