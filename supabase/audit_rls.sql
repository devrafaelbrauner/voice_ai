-- ════════════════════════════════════════════════════════════════
-- SETUP + AUDITORIA DE RLS — execute MANUALMENTE no SQL Editor.
-- Não é uma migration. Não rodar com `supabase db push`.
--
-- Por que manual:
--   As tabelas `recordings`, `custom_templates`, `doctor_profiles`
--   foram criadas via app/dashboard, não por migration — então o
--   `db push` pode falhar ao tentar aplicar policies em schemas
--   que ele não conhece. Aqui, cada operação é defensiva (EXCEPTION
--   WHEN OTHERS) e detecta o tipo de `user_id` dinamicamente.
--
-- Como usar:
--   1. Abra Supabase Dashboard → SQL Editor → New Query
--   2. Cole TODO o conteúdo deste arquivo
--   3. Run → veja NOTICES no painel inferior
-- ════════════════════════════════════════════════════════════════


-- ─── PARTE 1: Setup defensivo das policies RLS ──────────────────
DO $$
DECLARE
  v_user_id_type TEXT;
  v_predicate    TEXT;
BEGIN
  -- ── recordings ──
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='recordings') THEN

    BEGIN EXECUTE 'ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY';
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'recordings RLS: %', SQLERRM;
    END;

    SELECT data_type INTO v_user_id_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='recordings' AND column_name='user_id';

    v_predicate := CASE WHEN v_user_id_type = 'uuid'
                        THEN 'auth.uid() = user_id'
                        ELSE 'auth.uid()::text = user_id' END;

    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname='public' AND tablename='recordings'
                     AND policyname='Users can view own recordings') THEN
        EXECUTE format('CREATE POLICY "Users can view own recordings" ON public.recordings FOR SELECT USING (%s)', v_predicate);
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'recordings.SELECT: %', SQLERRM;
    END;

    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname='public' AND tablename='recordings'
                     AND policyname='Users can insert own recordings') THEN
        EXECUTE format('CREATE POLICY "Users can insert own recordings" ON public.recordings FOR INSERT WITH CHECK (%s)', v_predicate);
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'recordings.INSERT: %', SQLERRM;
    END;

    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname='public' AND tablename='recordings'
                     AND policyname='Users can update own recordings') THEN
        EXECUTE format('CREATE POLICY "Users can update own recordings" ON public.recordings FOR UPDATE USING (%s)', v_predicate);
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'recordings.UPDATE: %', SQLERRM;
    END;

    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname='public' AND tablename='recordings'
                     AND policyname='Users can delete own recordings') THEN
        EXECUTE format('CREATE POLICY "Users can delete own recordings" ON public.recordings FOR DELETE USING (%s)', v_predicate);
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'recordings.DELETE: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'recordings: tabela não existe, pulei.';
  END IF;

  -- ── custom_templates ──
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='custom_templates') THEN

    BEGIN EXECUTE 'ALTER TABLE public.custom_templates ENABLE ROW LEVEL SECURITY';
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'custom_templates RLS: %', SQLERRM;
    END;

    SELECT data_type INTO v_user_id_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='custom_templates' AND column_name='user_id';

    v_predicate := CASE WHEN v_user_id_type = 'uuid'
                        THEN 'auth.uid() = user_id'
                        ELSE 'auth.uid()::text = user_id' END;

    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname='public' AND tablename='custom_templates'
                     AND policyname='Users can manage own templates') THEN
        EXECUTE format('CREATE POLICY "Users can manage own templates" ON public.custom_templates USING (%s) WITH CHECK (%s)', v_predicate, v_predicate);
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'custom_templates: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'custom_templates: tabela não existe, pulei.';
  END IF;

  -- ── doctor_profiles ──
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='doctor_profiles') THEN

    BEGIN EXECUTE 'ALTER TABLE public.doctor_profiles ENABLE ROW LEVEL SECURITY';
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'doctor_profiles RLS: %', SQLERRM;
    END;

    SELECT data_type INTO v_user_id_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='doctor_profiles' AND column_name='user_id';

    v_predicate := CASE WHEN v_user_id_type = 'uuid'
                        THEN 'auth.uid() = user_id'
                        ELSE 'auth.uid()::text = user_id' END;

    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname='public' AND tablename='doctor_profiles'
                     AND policyname='Users can manage own profile') THEN
        EXECUTE format('CREATE POLICY "Users can manage own profile" ON public.doctor_profiles USING (%s) WITH CHECK (%s)', v_predicate, v_predicate);
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'doctor_profiles: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'doctor_profiles: tabela não existe, pulei.';
  END IF;
END $$;


-- ─── PARTE 2: Auditoria — execute APÓS o setup acima ─────────────

-- 2.1 RLS habilitado em todas as tabelas sensíveis?
SELECT schemaname, tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('evolutions', 'recordings', 'custom_templates', 'doctor_profiles', 'api_rate_limits')
ORDER BY tablename;
-- Esperado: rls_enabled = true em todas

-- 2.2 Listar policies ativas
SELECT tablename, policyname, cmd, qual::text AS using_expr, with_check::text AS check_expr
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('evolutions', 'recordings', 'custom_templates', 'doctor_profiles')
ORDER BY tablename, cmd;
-- Esperado: SELECT/INSERT/UPDATE/DELETE com auth.uid() em cada tabela

-- 2.3 Teste cross-user via REST (rodar fora do SQL Editor, ver supabase/README.md)
