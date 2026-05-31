# Supabase Edge Functions

Two functions proxy OpenAI calls so the API key never lives on user devices:

| Function | Route | Purpose |
|---|---|---|
| `openai-transcribe` | `POST /functions/v1/openai-transcribe` | Whisper transcription |
| `openai-chat` | `POST /functions/v1/openai-chat` | Chat completions (summary, ata, etc.) |

Both require a valid Supabase JWT (`verify_jwt = true`). Unauthenticated requests are rejected with 401.

## First-time deploy

```bash
# 1. Install Supabase CLI (once)
brew install supabase/tap/supabase

# 2. Link this project to your Supabase remote
cd /Users/rafaelbrauner/voice-ai-recorder
supabase login
supabase link --project-ref your-project-ref   # ref from EXPO_PUBLIC_SUPABASE_URL

# 3. Set the OpenAI key as a server-side secret
supabase secrets set OPENAI_API_KEY=sk-your-key-here

# 4. Run migrations: cria evolutions, api_rate_limits e tabelas de sync
supabase db push

# 5. Opcional: audite o RLS pelo SQL Editor
#    Cole TODO o conteúdo de supabase/audit_rls.sql → Run

# 6. Deploy both functions
supabase functions deploy openai-transcribe
supabase functions deploy openai-chat
```

## Smoke test

```bash
# Get a JWT by logging into the app, or:
SUPABASE_URL="https://your-project-ref.supabase.co"
SUPABASE_ANON_KEY="eyJ..."   # from .env

# 1. Health check (without JWT) → expect 401
curl -i -X POST "$SUPABASE_URL/functions/v1/openai-chat" \
  -H "apikey: $SUPABASE_ANON_KEY"

# 2. With a valid user JWT
USER_JWT="eyJ..."  # access_token from supabase.auth.signIn
curl -X POST "$SUPABASE_URL/functions/v1/openai-chat" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'

# 3. Rate limit test — 21 rapid requests should trigger 429 on the last ones
for i in $(seq 1 25); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$SUPABASE_URL/functions/v1/openai-chat" \
    -H "Authorization: Bearer $USER_JWT" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"x"}]}')
  echo "Request $i: HTTP $STATUS"
done
# Expected: first ~20 = 200, after that = 429
```

## RLS verification

```bash
# 1. Supabase Dashboard → SQL Editor → cole supabase/audit_rls.sql → Run
#    Verifique que evolutions, recordings, custom_templates e doctor_profiles
#    estão com RLS habilitado.

# 2. Cross-user isolation test (após setup):
# 1. Create two test users in the app
# 2. Log in as user A, export a recording → creates evolution row
# 3. Log in as user B, call:
curl -X GET "$SUPABASE_URL/rest/v1/evolutions" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $USER_B_JWT"
# Expected: [] (empty — user B cannot see user A's evolutions)
```

## Update after code changes

```bash
supabase functions deploy openai-transcribe
supabase functions deploy openai-chat
```

## Logs

```bash
supabase functions logs openai-transcribe --tail
supabase functions logs openai-chat --tail
```

Or via the Supabase dashboard → Edge Functions → select function → Logs.

## How the client picks proxy vs direct mode

`src/services/openai.ts` calls `getOpenAIMode()` before each request:

- **proxy** (default when signed in): POST to the edge function, JWT in Authorization header. No OpenAI key on device.
- **direct** (fallback): uses `apiKey` from SecureStore. Used when the user is not signed in, or as a manual override in Settings.

If the proxy is not deployed yet (404/500), the client surfaces a clear error so the developer knows to run the deploy command.

## Database schema

### Evolutions table

Stores medical evolution records linked to voice recordings. Each evolution contains:

- `id`: UUID primary key
- `doctor_id`: FK to auth.users (enforced via RLS)
- `patient_name`, `patient_birthdate`, `patient_health_plan`: Patient demographics
- `transcript`: Original AI transcription
- `summary`: Processed summary (after template/model processing)
- `template_used`: Which summary template was applied (summary|meeting|mindmap|email|etc)
- `cids`: JSON array of suggested ICD-10 codes
- `status`: draft | finalized | exported
- `exported_to_evopad`: Boolean flag + timestamp

**RLS Policies**: Users can only read/write/update/delete their own evolutions.

**Indexes**: doctor_id, patient_name, created_at, exported_to_evopad for query performance.

**Trigger**: `updated_at` auto-updates on every modification.

### Migration

Run `supabase db push` to create the table with all policies and triggers.

## EvoPad Integration

The app exports evolutions to EvoPad in two ways:

1. **Supabase (primary)**: Saved automatically when user clicks "Exportar EvoPad"
2. **Local EvoPad web (fallback)**: If EvoPad is running locally (localhost:5173/3000), also pushes via `POST /api/import/recording`

The client automatically discovers EvoPad availability and exports accordingly. See `src/services/evopad-export.ts` for implementation.
