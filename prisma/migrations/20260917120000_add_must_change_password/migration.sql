-- First-login password change for administrator-created accounts.
--
-- Additive and defaulted to false, so every account that already exists keeps
-- signing in exactly as before. Only accounts created from Admin > New User
-- after this migration are set true.
ALTER TABLE "user" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
