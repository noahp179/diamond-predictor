-- Accounts and entitlement tiers.
--
-- One row per signed-up user, created automatically by a trigger on
-- auth.users so there is never a signed-in user without a profile.
--
-- SECURITY NOTE ON `tier`
-- -----------------------
-- The whole point of this column is that the user must not be able to set it.
-- So there is no UPDATE policy for authenticated users at all: profiles are
-- readable by their owner and writable only by the service role. When payments
-- arrive, the webhook runs as the service role and flips this column; nothing
-- reachable from the browser can.
--
-- Row-level security is the backstop, not the mechanism. The server functions
-- redact locked predictions before they are serialised, so a free user's
-- response never contains the hidden probabilities in the first place — CSS
-- blur is a visual affordance over data that was already withheld, never the
-- thing doing the withholding.

CREATE TYPE public.user_tier AS ENUM ('free', 'premium');

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  tier public.user_tier NOT NULL DEFAULT 'free',
  -- Set when a paid plan starts; NULL for free accounts. Unused until payments
  -- are wired up, but the column is here so the tier flip has somewhere to
  -- record why it happened.
  premium_since TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- A user may read their own profile. Nobody may write one from the browser.
CREATE POLICY "Users read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

GRANT SELECT ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

-- Every new auth user gets a free profile, without the app having to remember.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER update_profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Backfill anyone who signed up before this migration ran.
INSERT INTO public.profiles (id, email)
SELECT id, email FROM auth.users
ON CONFLICT (id) DO NOTHING;
