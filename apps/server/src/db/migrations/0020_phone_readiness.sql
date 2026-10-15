-- What a paired phone says about its own ability to be heard.
--
-- Holding the event stream open says the app is running. It does not say anybody will hear
-- it: the alarm volume can be at zero, the app's notifications can be blocked, and on
-- Tecno, Infinix and Itel the battery manager stops an app that has not been exempted from
-- it, usually within the hour. None of that is visible from here, so the phone reads it
-- off its own settings and says. Every column is null until a phone running an app that
-- knows how has reported.
ALTER TABLE app_devices ADD COLUMN notifications_on INTEGER;
-- Whether a ring may light the screen and show over the lock screen. Android 14 lets the
-- person, or the phone's maker, take this away; on older phones it is always allowed.
ALTER TABLE app_devices ADD COLUMN full_screen_on INTEGER;
ALTER TABLE app_devices ADD COLUMN battery_exempt INTEGER;
-- Percent of the alarm stream's maximum. The app rings on the alarm stream so that a phone
-- set to silent still rings, which makes this — not the ringer volume — the one that
-- decides whether it is heard.
ALTER TABLE app_devices ADD COLUMN alarm_volume INTEGER;
-- When the phone last said all this.
ALTER TABLE app_devices ADD COLUMN checked_at TEXT;
