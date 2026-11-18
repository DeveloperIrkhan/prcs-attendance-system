-- Rename the "IT_OFFICER" role to "IT" (the name shown on the Roles page).
UPDATE "Role"
SET "name" = 'IT', "updatedAt" = NOW()
WHERE "name" = 'IT_OFFICER';
