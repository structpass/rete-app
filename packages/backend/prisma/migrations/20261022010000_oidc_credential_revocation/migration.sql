-- Existing credentials keep their sessions until a password change occurs.
ALTER TABLE "accounts" ADD COLUMN "credentials_changed_at" TIMESTAMPTZ;
