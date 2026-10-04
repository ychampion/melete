-- Calendars that can list events can also say when the person is free, which reads the same events.
UPDATE "connection" SET "scopes" = "scopes" || '["calendar.freebusy"]'::jsonb WHERE "provider" = 'caldav' AND "scopes" ? 'calendar.list' AND NOT "scopes" ? 'calendar.freebusy';
