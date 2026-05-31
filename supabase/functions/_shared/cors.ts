// CORS headers used by all edge functions. Allows the React Native app
// (and the EvoPad web) to call them without preflight headaches.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
