-- Create evolutions table for voice-ai-recorder integration with EvoPad
-- This table stores medical evolution records linked to recordings

CREATE TABLE IF NOT EXISTS public.evolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Doctor/User link
  doctor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  doctor_name TEXT NOT NULL,
  doctor_crm TEXT NOT NULL,
  doctor_rqe TEXT,

  -- Patient info
  patient_name TEXT NOT NULL,
  patient_birthdate DATE,
  patient_health_plan TEXT,

  -- Recording/Content link
  audio_uri TEXT NOT NULL, -- path to m4a file in storage
  transcript TEXT NOT NULL, -- original transcription
  summary TEXT NOT NULL, -- processed summary by AI

  -- AI processing metadata
  template_used TEXT NOT NULL DEFAULT 'summary', -- which template was used
  cids JSONB, -- array of ICD-10 codes suggested

  -- Status and export tracking
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'exported')),
  exported_to_evopad BOOLEAN DEFAULT FALSE,
  exported_at TIMESTAMP WITH TIME ZONE,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_evolutions_doctor_id ON public.evolutions(doctor_id);
CREATE INDEX idx_evolutions_patient_name ON public.evolutions(patient_name);
CREATE INDEX idx_evolutions_created_at ON public.evolutions(created_at DESC);
CREATE INDEX idx_evolutions_exported ON public.evolutions(exported_to_evopad);
CREATE INDEX idx_evolutions_doctor_patient ON public.evolutions(doctor_id, patient_name);

-- Row-Level Security (RLS)
ALTER TABLE public.evolutions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own evolutions
CREATE POLICY "Users can view own evolutions"
  ON public.evolutions FOR SELECT
  USING (auth.uid() = doctor_id);

-- Policy: Users can only insert evolutions for themselves
CREATE POLICY "Users can insert own evolutions"
  ON public.evolutions FOR INSERT
  WITH CHECK (auth.uid() = doctor_id);

-- Policy: Users can only update their own evolutions
CREATE POLICY "Users can update own evolutions"
  ON public.evolutions FOR UPDATE
  USING (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- Policy: Users can only delete their own evolutions
CREATE POLICY "Users can delete own evolutions"
  ON public.evolutions FOR DELETE
  USING (auth.uid() = doctor_id);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_evolutions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evolutions_updated_at_trigger
  BEFORE UPDATE ON public.evolutions
  FOR EACH ROW
  EXECUTE FUNCTION update_evolutions_updated_at();
