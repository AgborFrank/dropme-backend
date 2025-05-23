const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const http = require('http');
const authRoutes = require('./auth');
const rideRoutes = require('./rides');
const monetbilRoutes = require('./webhook-monetbil');

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
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const allowedOrigins = [
        'http://localhost:3000',
        process.env.EXPO_APP_URL || 'exp://.*',
        'https://dropme-backend-s7wz.onrender.com',
        'https://api.monetbil.com',
      ].filter(Boolean);

      if (!origin || allowedOrigins.some((o) => new RegExp(o).test(origin))) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
});

const BACKEND_URL = 'https://dropme-backend-s7wz.onrender.com';

// CORS Configuration
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:3000',
      process.env.EXPO_APP_URL || 'exp://.*',
      'https://dropme-backend-s7wz.onrender.com',
      'https://api.monetbil.com',
    ].filter(Boolean);

    if (!origin || allowedOrigins.some((o) => new RegExp(o).test(origin))) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
};

app.use(cors(corsOptions));
app.use(helmet());
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
console.log('Supabase client initialized');


// Pass Supabase client to routes
app.use((req, res, next) => {
  req.supabase = supabase;
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api', monetbilRoutes);

// Health check route
app.get('/', (req, res) => res.send('Car Hailing Backend'));

// Add real-time subscription for messages
supabase
  .channel('public:messages')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
    const newMessage = payload.new;
    console.log('New message detected:', newMessage);

    // Fetch the sender's details
    supabase
      .from('users')
      .select('first_name, last_name')
      .eq('id', newMessage.sender_id)
      .single()
      .then(({ data: sender, error }) => {
        if (error) {
          console.error('Error fetching sender:', error);
          return;
        }

        const messageWithSender = {
          ...newMessage,
          sender: {
            first_name: sender.first_name,
            last_name: sender.last_name,
          },
        };

        // Emit the new message to all clients in the chat room
        io.to(`chat_${newMessage.chat_id}`).emit('newMessage', messageWithSender);

        // Emit to the chat list for real-time updates
        io.emit('chatListUpdate', {
          chatId: newMessage.chat_id,
          lastMessage: {
            content: newMessage.content,
            created_at: newMessage.created_at,
          },
        });
      });
  })
  .subscribe();

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
      // Validate inputs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!riderId || !uuidRegex.test(riderId) || isNaN(lat) || isNaN(lng)) {
        throw new Error('Invalid riderData: userId must be a valid UUID, lat/lng must be numbers');
      }
  
      // Update rider location
      console.log('Calling upsert_user_location:', { p_user_id: riderId, p_lat: lat, p_lng: lng });
      const { error: upsertError } = await supabase
        .rpc('upsert_user_location', {
          p_user_id: riderId,
          p_lat: lat,
          p_lng: lng,
          p_role: 'rider',
          p_updated_at: new Date().toISOString(),
        });
      if (upsertError) {
        console.error('Upsert error:', upsertError);
        throw upsertError;
      }
  
      // Fetch nearby drivers
      console.log('Calling nearby_drivers:', { query_lat: lat, query_lng: lng, max_distance: 5000, rider_id: riderId });
      const { data, error } = await supabase.rpc('nearby_drivers', {
        query_lat: lat,
        query_lng: lng,
        max_distance: 5000,
        rider_id: riderId,
      });
      if (error) {
        console.error('Nearby drivers error:', error);
        throw error;
      }
  
      // Emit results
      socket.emit('nearbyDrivers', data);
      console.log('Sent nearbyDrivers:', data);
    } catch (err) {
      console.error('Error in requestNearbyDrivers:', err);
      socket.emit('error', { message: 'Failed to fetch drivers', error: err.message });
    }
  });

  socket.on('newRideRequest', async (rideData) => {
    console.log('Received newRideRequest:', rideData);
    const {
      riderId,
      rideType,
      distance, // meters, number
      cost, // from frontend pricelist.ts
      passenger = 'John Doe',
      rating = 4.8,
      pickup, // { address: string, lat: number, lng: number }
      dropoff, // { address: string, lat: number, lng: number }
      eta,
      duration,
      bookingDate = null,
      passengerCount = 1,
      paymentMethod = 'Cash',
    } = rideData;

    try {
      // Validate inputs
      if (!riderId || !rideType || !distance || !cost || !pickup || !dropoff) {
        throw new Error('Missing required fields: riderId, rideType, distance, cost, pickup, dropoff');
      }
      if (typeof cost !== 'number' || cost <= 0) {
        throw new Error('Invalid cost: must be a positive number');
      }
      if (typeof distance !== 'number' || distance <= 0) {
        throw new Error('Invalid distance: must be a positive number');
      }
      if (typeof pickup !== 'object' || typeof dropoff !== 'object') {
        throw new Error('Invalid pickup or dropoff: must be JSON objects');
      }

      const rideRequest = {
        id: uuidv4(),
        rider_id: riderId,
        driver_id: null, // Set later in acceptRide
        passenger,
        rating,
        pickup, // jsonb
        dropoff, // jsonb
        fare: cost, // real, XAF
        eta,
        status: 'pending',
        created_at: new Date().toISOString(),
        ridetype: rideType,
        distance: `${distance} m`, // text
        duration,
        booking_date: bookingDate,
        passenger_count: passengerCount,
        payment_method: paymentMethod,
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
      socket.emit('error', { message: 'Failed to create ride request', error: err.message });
    }
  });

  socket.on("acceptRide", async ({ driverId, requestId }) => {
    try {
      // Fetch ride to validate
      const { data: ride, error: fetchError } = await supabase
        .from("ride_requests")
        .select("*")
        .eq("id", requestId)
        .eq("status", "pending")
        .maybeSingle();
  
      if (fetchError) {
        console.error("Error fetching ride:", fetchError);
        throw new Error("Database error");
      }
  
      if (!ride) {
        console.log(`Ride ${requestId} not found or not pending`);
        socket.emit("error", { message: "Ride not available or already processed" });
        return;
      }
  
      // Update ride
      const { data: updatedRide, error: updateError } = await supabase
        .from("ride_requests")
        .update({ driver_id: driverId, status: "accepted" })
        .eq("id", requestId)
        .eq("status", "pending") // Ensure still pending
        .select()
        .single();
  
      if (updateError) {
        console.error("Error updating ride:", updateError);
        throw new Error("Failed to accept ride");
      }
  
      console.log(`Ride ${requestId} accepted by driver ${driverId}`);
      io.emit("tripUpdate", {
        id: requestId,
        rider_id: updatedRide.rider_id,
        driverId,
        status: "accepted",
        fare: updatedRide.fare,
        eta: updatedRide.eta,
        pickup: updatedRide.pickup,
        dropoff: updatedRide.dropoff,
      });
    } catch (error) {
      console.error("Error in acceptRide:", error.message);
      socket.emit("error", { message: "Failed to accept ride", error: error.message });
    }
  });

  socket.on("confirmRide", async ({ driverId, requestId }) => {
    try {
      const { data: ride, error: fetchError } = await supabase
        .from("ride_requests")
        .select("*")
        .eq("id", requestId)
        .eq("status", "accepted")
        .eq("driver_id", driverId)
        .maybeSingle();
  
      if (fetchError) {
        console.error("Error fetching ride:", fetchError);
        throw new Error("Database error");
      }
  
      if (!ride) {
        console.log(`Ride ${requestId} not found, not accepted, or not assigned to driver ${driverId}`);
        socket.emit("error", { message: "Ride not available or not assigned" });
        return;
      }
  
      const { data: updatedRide, error: updateError } = await supabase
        .from("ride_requests")
        .update({ status: "confirmed" })
        .eq("id", requestId)
        .eq("status", "accepted")
        .select()
        .single();
  
      if (updateError) {
        console.error("Error confirming ride:", updateError);
        throw new Error("Failed to confirm ride");
      }
  
      console.log(`Ride ${requestId} confirmed by driver ${driverId}`);
      io.emit("tripUpdate", {
        id: requestId,
        rider_id: updatedRide.rider_id,
        driverId,
        status: "confirmed",
        fare: updatedRide.fare,
        eta: updatedRide.eta,
        pickup: updatedRide.pickup,
        dropoff: updatedRide.dropoff,
      });
    } catch (error) {
      console.error("Error in confirm ride:", error.message);
      socket.emit("error", { message: "Failed to confirm ride", error: error.message });
    }
  });

  socket.on('declineRide', async (data) => {
    console.log('Received declineRide:', data);
    const { driverId, requestId } = data;

    try {
      if (!driverId || !requestId) {
        throw new Error('Invalid declineRide data: driverId and requestId required');
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
      socket.emit('rideDeclined', { requestId, driverId });
    } catch (err) {
      console.error('Error in declineRide:', err.message);
      socket.emit('error', { message: 'Failed to decline ride', error: err.message });
    }
  });
  socket.on("cancelRide", async ({ requestId, reason }) => {
    try {
      const { error } = await supabase
        .from("ride_requests")
        .update({ status: "canceled", cancellation_reason: reason })
        .eq("id", requestId);
      if (error) throw error;
      io.emit("rideUpdate", { id: requestId, status: "canceled" });
    } catch (error) {
      socket.emit("error", { message: "Failed to cancel ride", error });
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


  // Updated handler for trip update with vehicle and ride type validation
  socket.on("tripUpdate", async (tripData) => {
    console.log("Received tripUpdate:", tripData);
    const { rider_id, driver_id, status } = tripData;
    try {
      // Fetch ride request to get rideType
      const { data: ride, error: rideError } = await supabase
        .from("ride_requests")
        .select("ride_type")
        .eq("rider_id", rider_id)
        .eq("status", "pending")
        .single();
      if (rideError) throw rideError;

      // Validate driver’s vehicle
      const { data: vehicle, error: vehicleError } = await supabase
        .from("vehicles")
        .select("make, model, license_plate, ride_type, status")
        .eq("driver_id", driver_id)
        .eq("status", "active")
        .single();
      if (vehicleError || !vehicle) {
        throw new Error("No active vehicle found for driver or vehicle error");
      }
      if (vehicle.ride_type !== ride.ride_type) {
        throw new Error("Vehicle ride type does not match rider request");
      }

      // Update ride request
      const { data: updatedRide, error: updateError } = await supabase
        .from("ride_requests")
        .update({ status, driver_id })
        .eq("rider_id", rider_id)
        .eq("status", "pending")
        .select()
        .single();
      if (updateError) throw updateError;

      // Fetch driver details
      const { data: driver, error: driverError } = await supabase
        .from("users")
        .select("first_name")
        .eq("id", driver_id)
        .single();
      if (driverError) throw driverError;

      const responseRide = {
        ...updatedRide,
        driver: {
          name: driver.first_name,
          rating: vehicle.rating || 5.0, // Use vehicle rating if available
          vehicle: `${vehicle.make} ${vehicle.model}`,
          licensePlate: vehicle.license_plate,
        },
      };

      io.emit("tripUpdate", responseRide);
      console.log("Sent tripUpdate:", responseRide);
    } catch (err) {
      console.error("Error in tripUpdate:", err);
      socket.emit("error", { message: err.message || "Failed to update trip", error: err.message });
    }
  });

  // Updated handler for driver location updates
  socket.on("updateDriverLocation", async (locationData) => {
    console.log("Received updateDriverLocation:", locationData);
    const { driverId, lat, lng } = locationData;
    try {
      const { error } = await supabase
        .rpc("upsert_user_location", {
          p_user_id: driverId,
          p_lat: lat,
          p_lng: lng,
          p_role: "driver",
          p_updated_at: new Date().toISOString(),
        });
      if (error) throw error;

      // Update users.location for consistency (optional)
      await supabase
        .from("users")
        .update({ location: `SRID=4326;POINT(${lng} ${lat})` })
        .eq("id", driverId);

      io.emit("driverLocation", { driverId, lat, lng });
      console.log("Sent driverLocation:", { driverId, lat, lng });
    } catch (err) {
      console.error("Error in updateDriverLocation:", err);
      socket.emit("error", { message: "Failed to update driver location", error: err.message });
    }
  });

  // Updated handler for chat messages
  socket.on("newMessage", async (messageData) => {
    console.log("Received newMessage:", messageData);
    const { chatId, senderId, content } = messageData;
    try {
      const { data, error } = await supabase
        .from("messages")
        .insert({
          chat_id: chatId,
          sender_id: senderId,
          content,
        })
        .select();
      if (error) throw error;

      io.emit("newMessage", data[0]);
      console.log("Sent newMessage:", data[0]);
    } catch (err) {
      console.error("Error in newMessage:", err);
      socket.emit("error", { message: "Failed to send message", error: err.message });
    }
  });
 
 
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

  socket.on('fetchPastRides', async (data) => {
    try {
      if (!data.userId) {
        socket.emit('error', 'Missing user ID for fetching past rides');
        return;
      }

      const { data: rides, error } = await supabase
        .from('rides')
        .select(`
          id,
          rider_id,
          driver_id,
          pickup_location,
          dropoff_location,
          status,
          created_at,
          distance_km,
          cost
        `)
        .eq('rider_id', data.userId)
        .eq('status', 'completed')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to fetch past rides: ' + error.message);
        return;
      }

      // Transform geography data to lat/lng for frontend
      const transformedRides = rides.map(ride => ({
        ...ride,
        pickup_location: {
          latitude: ride.pickup_location.coordinates[1],
          longitude: ride.pickup_location.coordinates[0],
        },
        dropoff_location: {
          latitude: ride.dropoff_location.coordinates[1],
          longitude: ride.dropoff_location.coordinates[0],
        },
      }));

      console.log('Past rides fetched:', transformedRides);
      socket.emit('pastRidesFetched', { rides: transformedRides || [] });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('fetchActiveRide', async (data) => {
    try {
      if (!data.userId) {
        socket.emit('error', 'Missing user ID for fetching active ride');
        return;
      }

      const { data: ride, error } = await supabase
        .from('rides')
        .select(`
          id,
          rider_id,
          driver_id,
          pickup_location,
          dropoff_location,
          status,
          created_at,
          distance_km,
          cost
        `)
        .eq('rider_id', data.userId)
        .in('status', ['requested', 'accepted', 'in-progress'])
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 means no rows found
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to fetch active ride: ' + error.message);
        return;
      }

      // Transform geography data to lat/lng for frontend
      const transformedRide = ride ? {
        ...ride,
        pickup_location: {
          latitude: ride.pickup_location.coordinates[1],
          longitude: ride.pickup_location.coordinates[0],
        },
        dropoff_location: {
          latitude: ride.dropoff_location.coordinates[1],
          longitude: ride.dropoff_location.coordinates[0],
        },
      } : null;

      console.log('Active ride fetched:', transformedRide);
      socket.emit('activeRideFetched', { ride: transformedRide });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('cancelRide', async (data) => {
    try {
      if (!data.rideId || !data.userId) {
        socket.emit('error', 'Missing required fields for cancelling ride');
        return;
      }

      const { data: existingRide, error: fetchError } = await supabase
        .from('rides')
        .select('*')
        .eq('id', data.rideId)
        .eq('rider_id', data.userId)
        .in('status', ['requested', 'accepted', 'in-progress'])
        .single();

      if (fetchError || !existingRide) {
        console.error('Supabase error:', fetchError);
        socket.emit('error', 'Ride not found or not cancellable');
        return;
      }

      const { data, error } = await supabase
        .from('rides')
        .update({ status: 'canceled' })
        .eq('id', data.rideId)
        .select()
        .single();

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to cancel ride: ' + error.message);
        return;
      }

      console.log('Ride cancelled:', data);
      socket.emit('rideCancelled', { rideId: data.id });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });


  //Chat Feature
  socket.on('fetchChats', async (data) => {
    try {
      if (!data.userId) {
        socket.emit('error', 'Missing user ID for fetching chats');
        return;
      }

      const { data: chats, error } = await supabase
        .from('chats')
        .select(`
          id,
          rider_id,
          driver_id,
          created_at,
          rider:users!chats_rider_id_fkey (first_name, last_name, avatar),
          driver:users!chats_driver_id_fkey (first_name, last_name, avatar),
          messages (content, created_at)
        `)
        .or(`rider_id.eq.${data.userId},driver_id.eq.${data.userId}`)
        .order('created_at', { foreignTable: 'messages', ascending: false });

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to fetch chats: ' + error.message);
        return;
      }

      // Process chats to include only the latest message
      const processedChats = chats.map(chat => {
        const latestMessage = chat.messages.length > 0 ? chat.messages[0] : null;
        return {
          ...chat,
          last_message: latestMessage ? {
            content: latestMessage.content,
            created_at: latestMessage.created_at,
          } : null,
          messages: undefined, // Remove the messages array to reduce payload size
        };
      });

      console.log('Chats fetched:', processedChats);
      socket.emit('chatsFetched', { chats: processedChats || [] });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('fetchMessages', async (data) => {
    try {
      if (!data.chatId) {
        socket.emit('error', 'Missing chat ID for fetching messages');
        return;
      }

      const { data: messages, error } = await supabase
        .from('messages')
        .select(`
          id,
          chat_id,
          sender_id,
          content,
          created_at,
          sender:users!messages_sender_id_fkey (first_name, last_name)
        `)
        .eq('chat_id', data.chatId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to fetch messages: ' + error.message);
        return;
      }

      console.log('Messages fetched:', messages);
      socket.emit('messagesFetched', { messages: messages || [] });
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('sendMessage', async (data) => {
    try {
      if (!data.chatId || !data.senderId || !data.content) {
        socket.emit('error', 'Missing required fields for sending message');
        return;
      }

      const { data: message, error } = await supabase
        .from('messages')
        .insert([{
          chat_id: data.chatId,
          sender_id: data.senderId,
          content: data.content,
        }])
        .select(`
          id,
          chat_id,
          sender_id,
          content,
          created_at,
          sender:users!messages_sender_id_fkey (first_name, last_name)
        `)
        .single();

      if (error) {
        console.error('Supabase error:', error);
        socket.emit('error', 'Failed to send message: ' + error.message);
        return;
      }

      console.log('Message sent:', message);
      io.to(`chat_${data.chatId}`).emit('newMessage', message);
    } catch (err) {
      console.error('Server error:', err);
      socket.emit('error', 'Server error: ' + err.message);
    }
  });

  socket.on('joinChat', (data) => {
    if (!data.chatId) {
      socket.emit('error', 'Missing chat ID for joining chat');
      return;
    }
    socket.join(`chat_${data.chatId}`);
    console.log(`Socket ${socket.id} joined chat_${data.chatId}`);
  });

  socket.on('leaveChat', (data) => {
    if (!data.chatId) {
      socket.emit('error', 'Missing chat ID for leaving chat');
      return;
    }
    socket.leave(`chat_${data.chatId}`);
    console.log(`Socket ${socket.id} left chat_${data.chatId}`);
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
module.exports = app;