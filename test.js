console.log('Test script starting...');

// Test environment variables
require('dotenv').config();
console.log('Environment variables loaded');
console.log({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY
});

// Test Supabase client
const { createClient } = require('@supabase/supabase-js');
console.log('Supabase module loaded');

try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log('Supabase client created successfully');
} catch (error) {
    console.error('Error creating Supabase client:', error);
}
