-- LOCAL DEV ONLY: synthetic backdated sightings so the forecast and map can be exercised.
-- Never run against production. photo_key is NULL; set it to files under uploads/ if you want popups with images.
TRUNCATE sightings;
INSERT INTO sightings (time, cell_lat, cell_lng, stage, color_score, colors, trees, scene, note, photo_key, model)
SELECT LEAST(now() - interval '1 minute', date_trunc('day', now()) - make_interval(days => d) + make_interval(hours => h)),
       c.lat, c.lng,
       CASE WHEN s >= 85 THEN 'peak' WHEN s >= 50 THEN 'near_peak' WHEN s >= 15 THEN 'turning' ELSE 'green' END,
       s, c.colors, c.trees, c.scene, c.note, c.photo, 'dev-seed'
FROM (VALUES
  (40.78, -73.97, 6.0, 30, ARRAY['orange','red','gold'], 'sugar maple',  'a cluster of sugar maples on the shore of a small lake',       'The maples by the lake are almost there.', NULL),
  (40.80, -73.96, 4.0, 20, ARRAY['yellow','green'],      'honey locust', 'honey locusts with small golden leaves over a gravel path',    'Gold creeping in along the north path.',   NULL),
  (40.77, -73.98, 8.5, 45, ARRAY['red','crimson'],       'red maple',    'a single large red maple beside a stone wall near the street', 'Full red canopy, worth the detour.',       NULL),
  (40.75, -73.99, 1.0,  5, ARRAY['green'],               'london plane', 'tall london plane trees lining a busy avenue',                 'Still summer green here.',                 NULL)
) AS c(lat, lng, rate, base, colors, trees, scene, note, photo),
LATERAL generate_series(0, 9) AS d,
LATERAL generate_series(9, 15, 3) AS h,
LATERAL (SELECT LEAST(100, GREATEST(0, round(c.base + c.rate * (9 - d) + (random() * 6 - 3))))::smallint AS s) sc;
