# Deployment Guide - Voice AI Recorder + EvoPad

This guide walks through deploying the complete system with Supabase Edge Functions for secure OpenAI access.

## Prerequisites

- ✅ Supabase CLI installed (`brew install supabase/tap/supabase`)
- ✅ Supabase project created (ref: `your-project-ref`)
- ✅ OpenAI API key obtained
- ✅ Local environment file configured (`.env` with `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`)

## Step 1: Link Local Project to Supabase Remote

```bash
cd /Users/rafaelbrauner/voice-ai-recorder

# Login to your Supabase account
supabase login

# Link to remote project
supabase link --project-ref your-project-ref
```

## Step 2: Set Server-Side Secrets

Store your OpenAI API key **server-side only**. It will **never** be stored on user devices.

```bash
# Get your key from https://platform.openai.com/api-keys
supabase secrets set OPENAI_API_KEY=sk-proj-your-actual-key-here
```

Verify secret was set:
```bash
supabase secrets list
```

## Step 3: Create Database Tables

This creates the `evolutions` table with RLS policies.

```bash
supabase db push
```

You should see output like:
```
Applying migration: 20240524000000_create_evolutions_table.sql
✓ Applied successfully
```

## Step 4: Deploy Edge Functions

Deploy the two proxy functions.

```bash
supabase functions deploy openai-transcribe
supabase functions deploy openai-chat
```

Monitor the deployment:
```bash
# View logs in real-time
supabase functions logs openai-transcribe --tail
```

## Step 5: Smoke Test (Verify Deployment)

Test that Edge Functions are accessible and working.

### Test 1: Health Check (Expect 401 without auth)
```bash
SUPABASE_URL="https://your-project-ref.supabase.co"
SUPABASE_ANON_KEY="eyJ..."  # from your .env

curl -i -X POST "$SUPABASE_URL/functions/v1/openai-chat" \
  -H "apikey: $SUPABASE_ANON_KEY"
# Expected: 401 Unauthorized
```

### Test 2: With Valid JWT
First, log into the app and copy your JWT from the session. Then:

```bash
USER_JWT="eyJ..."  # access_token from app login

curl -X POST "https://your-project-ref.supabase.co/functions/v1/openai-chat" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello, test this"}]}'

# Expected: 200 OK with JSON response
# { "content": "...", "input_tokens": 10, "output_tokens": 5, "cost_usd": 0.00015 }
```

### Test 3: App-Level Test
1. **Open the app**
2. **Log in** with email/password
3. **Check Settings** → "Modo OpenAI"
   - Should show **green Shield** badge + "Modo seguro (proxy)"
   - This confirms proxy mode is active
4. **Record audio** and transcribe
5. **Process with IA** (select template)
6. **Click "Exportar EvoPad"**
   - Should save to Supabase
   - If EvoPad web is running locally, also exports there
   - Alert shows: "Sucesso! ✓ Evolução importada em EvoPad"

## Step 6: Manual Verification (Supabase Dashboard)

1. Go to https://app.supabase.com → your project → SQL Editor
2. Run:
   ```sql
   SELECT COUNT(*) as total_evolutions FROM evolutions;
   ```
3. Should show increasing count as you export recordings

## Troubleshooting

### Issue: "Sessão Supabase necessária para usar o proxy"
**Cause**: User not logged in
**Fix**: Log in with email/password first

### Issue: Edge Function returns 401
**Cause**: JWT is invalid or expired
**Fix**: 
- Re-login in the app
- Try a fresh JWT from current session
- Check Supabase auth is working

### Issue: OpenAI API error in function logs
**Cause**: Wrong API key or key missing
**Fix**:
```bash
# Check secret is set
supabase secrets list

# If missing, set it again
supabase secrets set OPENAI_API_KEY=sk-proj-...
```

### Issue: "Force Direct Mode" still active
**Cause**: Setting persists from testing
**Fix**: 
1. Go to Settings → "Modo OpenAI"
2. Toggle OFF "Forçar chave própria"
3. Close and reopen app

## Rollback (If Needed)

If you need to pause proxy mode temporarily:

1. **In app**: Settings → "Modo OpenAI" → Toggle "Forçar chave própria" ON
   - App will use client-side API key instead
   - Useful if Edge Function is down

2. **Disable function** (doesn't delete):
   ```bash
   supabase functions disable openai-transcribe
   supabase functions disable openai-chat
   ```

3. **Re-enable function**:
   ```bash
   supabase functions enable openai-transcribe
   supabase functions enable openai-chat
   ```

## Monitoring & Logs

### View Edge Function Logs
```bash
supabase functions logs openai-transcribe --tail
supabase functions logs openai-chat --tail
```

### Query Usage Stats
```bash
# In Supabase SQL Editor:
SELECT 
  doctor_id, 
  COUNT(*) as exports,
  MAX(exported_at) as last_export
FROM evolutions
WHERE exported_to_evopad = true
GROUP BY doctor_id;
```

## Success Criteria

✅ All tests pass  
✅ App shows "Modo seguro (proxy)" in Settings  
✅ Recordings export and save to Supabase  
✅ No API key appears in app logs or crash reports  
✅ Cost tracking appears in Supabase  
✅ Local EvoPad receives exports (if running)  

---

**Deployed:** [Your date]  
**API Key Location:** Supabase Edge Function environment (server-side only)  
**Fallback Mode:** "Forçar chave própria" in Settings  
