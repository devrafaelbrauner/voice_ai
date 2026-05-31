-- Tables used by the app-level cloud sync flow.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.recordings (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  custom_name TEXT,
  transcript TEXT,
  summary TEXT,
  template_id TEXT,
  patient_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, file_name)
);

CREATE INDEX IF NOT EXISTS idx_recordings_user_created
  ON public.recordings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_user_patient
  ON public.recordings(user_id, patient_name);

DROP TRIGGER IF EXISTS recordings_updated_at_trigger ON public.recordings;
CREATE TRIGGER recordings_updated_at_trigger
  BEFORE UPDATE ON public.recordings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own recordings" ON public.recordings;
CREATE POLICY "Users can view own recordings"
  ON public.recordings FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own recordings" ON public.recordings;
CREATE POLICY "Users can insert own recordings"
  ON public.recordings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own recordings" ON public.recordings;
CREATE POLICY "Users can update own recordings"
  ON public.recordings FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own recordings" ON public.recordings;
CREATE POLICY "Users can delete own recordings"
  ON public.recordings FOR DELETE
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.custom_templates (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_custom_templates_user_created
  ON public.custom_templates(user_id, created_at DESC);

DROP TRIGGER IF EXISTS custom_templates_updated_at_trigger ON public.custom_templates;
CREATE TRIGGER custom_templates_updated_at_trigger
  BEFORE UPDATE ON public.custom_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.custom_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own templates" ON public.custom_templates;
CREATE POLICY "Users can manage own templates"
  ON public.custom_templates
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.doctor_profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  title TEXT,
  crm_number TEXT,
  crm_uf TEXT,
  address TEXT,
  phone TEXT,
  city TEXT,
  professional_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS doctor_profiles_updated_at_trigger ON public.doctor_profiles;
CREATE TRIGGER doctor_profiles_updated_at_trigger
  BEFORE UPDATE ON public.doctor_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.doctor_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own profile" ON public.doctor_profiles;
CREATE POLICY "Users can manage own profile"
  ON public.doctor_profiles
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
