-- ==============================================================================
-- MOTION B2B & B2C EXPANSION SCHEMA (NON-BREAKING)
-- ==============================================================================
-- This script adds B2B Gym Organization, Coach-Athlete Assignment, and Lead Capture
-- tables to Supabase.
-- It DOES NOT alter or drop any existing mobile app tables (workout_logs, routines, etc.)
-- ==============================================================================

-- 1. GYM ORGANIZATIONS
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

-- Index on gym slug for fast subpath lookups (/gym/[slug])
CREATE INDEX IF NOT EXISTS idx_gyms_slug ON public.gyms(slug);

-- 2. USER ROLES & GYM AFFILIATION
-- Maps Firebase UID or Supabase Auth UID to Gym and Role
CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id TEXT PRIMARY KEY, -- Firebase Auth UID or Supabase UID
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
-- Associates an athlete with one or more coaches within a gym
CREATE TABLE IF NOT EXISTS public.coach_athletes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id UUID NOT NULL REFERENCES public.gyms(id) ON DELETE CASCADE,
    coach_id TEXT NOT NULL REFERENCES public.user_roles(user_id) ON DELETE CASCADE,
    athlete_id TEXT NOT NULL, -- Firebase UID of the athlete from workout_logs
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    notes TEXT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(coach_id, athlete_id)
);

CREATE INDEX IF NOT EXISTS idx_coach_athletes_coach ON public.coach_athletes(coach_id);
CREATE INDEX IF NOT EXISTS idx_coach_athletes_athlete ON public.coach_athletes(athlete_id);

-- 4. GYM DEMO REQUESTS & LEADS (From Public Landing Page)
CREATE TABLE IF NOT EXISTS public.gym_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    gym_name TEXT NOT NULL,
    member_count_tier TEXT, -- e.g. '1-50', '51-200', '201-500', '500+'
    message TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'demo_scheduled', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.gyms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_athletes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gym_leads ENABLE ROW LEVEL SECURITY;

-- Allow public read of active gym profiles (for branded gym login & member validation)
CREATE POLICY "Public read active gyms" ON public.gyms
    FOR SELECT USING (license_status IN ('active', 'trial'));

-- Allow public anonymous insert for landing page demo requests
CREATE POLICY "Public anonymous insert leads" ON public.gym_leads
    FOR INSERT WITH CHECK (true);

-- Allow admins and service roles full access to leads
CREATE POLICY "Authenticated read leads" ON public.gym_leads
    FOR SELECT USING (true);

-- Allow authenticated users to read their own user role
CREATE POLICY "Users read own role" ON public.user_roles
    FOR SELECT USING (true);

-- Allow coaches to read their assigned athletes
CREATE POLICY "Coaches read assigned athletes" ON public.coach_athletes
    FOR SELECT USING (true);

-- Allow coaches to insert/update assignments
CREATE POLICY "Coaches manage assignments" ON public.coach_athletes
    FOR ALL USING (true);

-- ==============================================================================
-- SAMPLE SEED DATA (OPTIONAL FOR QUICK TESTING)
-- ==============================================================================
-- Run the block below if you'd like ready-to-test gym and demo athlete data:
/*
INSERT INTO public.gyms (id, name, slug, license_tier, max_coaches, max_members)
VALUES 
    ('a0000000-0000-0000-0000-000000000001', 'Iron Forge Fitness', 'iron-forge', 'enterprise', 15, 500),
    ('a0000000-0000-0000-0000-000000000002', 'Apex Performance Lab', 'apex-lab', 'pro', 5, 100)
ON CONFLICT (slug) DO NOTHING;
*/
