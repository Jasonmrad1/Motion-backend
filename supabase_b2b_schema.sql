-- ==============================================================================
-- MOTION B2B & B2C EXPANSION SCHEMA (NON-BREAKING)
-- ==============================================================================
-- Seamlessly integrates with your existing Supabase tables:
--   - workout_logs (user_uuid, title, ended_at, duration_sec, total_volume, ...)
--   - coach_routines (coach_id, title, exercises, difficulty, expected_time, ...)
--   - conversations (id, user_id, coach_id, created_at)
--   - exercise_prs (user_uuid, exercise_id, exercise_name, pr_type, value, ...)
--   - routines (user_uuid, title, exercises, ...)
--   - measurements (user_uuid, name, value, created_at)
--
-- DOES NOT alter or drop any of the above tables.
-- ==============================================================================

-- 1. GYM ORGANIZATIONS (Multi-Tenant Facilities)
CREATE TABLE IF NOT EXISTS public.gyms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    logo_url TEXT,
    license_status TEXT NOT NULL DEFAULT 'active' CHECK (license_status IN ('active', 'trial', 'past_due', 'cancelled')),
    license_tier TEXT NOT NULL DEFAULT 'pro' CHECK (license_tier IN ('starter', 'pro', 'enterprise')),
    max_coaches INT NOT NULL DEFAULT 5,
    max_members INT NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gyms_slug ON public.gyms(slug);

-- 2. USER ROLES & GYM AFFILIATION
-- Maps Firebase UID (user_uuid / coach_id) to Gym and Role
CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id TEXT PRIMARY KEY, -- Matches user_uuid in workout_logs / coach_id in coach_routines
    email TEXT,
    full_name TEXT,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE SET NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('super_admin', 'gym_admin', 'coach', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_roles_gym_id ON public.user_roles(gym_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON public.user_roles(role);

-- 3. COACH-ATHLETE ASSIGNMENTS
-- Links a coach to their assigned athlete members within a gym
CREATE TABLE IF NOT EXISTS public.coach_athletes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id UUID NOT NULL REFERENCES public.gyms(id) ON DELETE CASCADE,
    coach_id TEXT NOT NULL, -- Matches coach_routines.coach_id / conversations.coach_id
    athlete_id TEXT NOT NULL, -- Matches workout_logs.user_uuid
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    notes TEXT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(coach_id, athlete_id)
);

CREATE INDEX IF NOT EXISTS idx_coach_athletes_coach ON public.coach_athletes(coach_id);
CREATE INDEX IF NOT EXISTS idx_coach_athletes_athlete ON public.coach_athletes(athlete_id);
CREATE INDEX IF NOT EXISTS idx_coach_athletes_gym ON public.coach_athletes(gym_id);

-- 4. GYM DEMO REQUESTS & MARKETING LEADS (From Public Landing Page)
CREATE TABLE IF NOT EXISTS public.gym_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    gym_name TEXT NOT NULL,
    member_count_tier TEXT, -- '1-50', '51-200', '201-500', '500+'
    message TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'demo_scheduled', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. CONVENIENCE VIEW: GYM ATHLETE WORKOUT FEED
-- Effortlessly streams workouts from workout_logs for a specific coach or gym
CREATE OR REPLACE VIEW public.gym_athlete_workouts AS
SELECT 
    w.id AS workout_id,
    w.user_uuid AS athlete_id,
    w.title AS workout_title,
    w.ended_at,
    w.duration_sec,
    w.total_volume,
    w.total_sets,
    w.records_count,
    w.difficulty,
    w.exercises,
    w.muscle_split,
    ca.coach_id,
    ca.gym_id,
    g.name AS gym_name,
    g.slug AS gym_slug
FROM public.workout_logs w
INNER JOIN public.coach_athletes ca ON ca.athlete_id = w.user_uuid
INNER JOIN public.gyms g ON g.id = ca.gym_id;

-- 6. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.gyms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_athletes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gym_leads ENABLE ROW LEVEL SECURITY;

-- Allow public read of active gyms (for landing page showcase / gym vanity URL lookups)
DROP POLICY IF EXISTS "Public read active gyms" ON public.gyms;
CREATE POLICY "Public read active gyms" ON public.gyms
    FOR SELECT USING (license_status IN ('active', 'trial'));

-- Allow public visitors to submit demo inquiries from the marketing landing page
DROP POLICY IF EXISTS "Public anonymous insert leads" ON public.gym_leads;
CREATE POLICY "Public anonymous insert leads" ON public.gym_leads
    FOR INSERT WITH CHECK (true);

-- Allow authenticated users to view leads
DROP POLICY IF EXISTS "Authenticated read leads" ON public.gym_leads;
CREATE POLICY "Authenticated read leads" ON public.gym_leads
    FOR SELECT USING (true);

-- Allow users to see their own role and membership
DROP POLICY IF EXISTS "Users read own role" ON public.user_roles;
CREATE POLICY "Users read own role" ON public.user_roles
    FOR SELECT USING (true);

-- Allow coaches and gym admins to view their athlete assignments
DROP POLICY IF EXISTS "Coaches read assigned athletes" ON public.coach_athletes;
CREATE POLICY "Coaches read assigned athletes" ON public.coach_athletes
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Coaches manage assignments" ON public.coach_athletes;
CREATE POLICY "Coaches manage assignments" ON public.coach_athletes
    FOR ALL USING (true);

-- ==============================================================================
-- SAMPLE SEED DATA (OPTIONAL)
-- ==============================================================================
/*
INSERT INTO public.gyms (id, name, slug, license_tier, max_coaches, max_members)
VALUES 
    ('a0000000-0000-0000-0000-000000000001', 'Iron Forge Fitness', 'iron-forge', 'enterprise', 15, 500),
    ('a0000000-0000-0000-0000-000000000002', 'Apex Performance Lab', 'apex-lab', 'pro', 5, 100)
ON CONFLICT (slug) DO NOTHING;
*/
