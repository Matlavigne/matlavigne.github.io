-- Base D1 du Worker de notifications. Aucune donnée nominative :
-- un abonnement n'est qu'une adresse technique fournie par Apple, Google ou Mozilla.

CREATE TABLE IF NOT EXISTS subscriptions (
  trip       TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (trip, endpoint)
);

-- Calendrier : identifiant et heure seulement, jamais le texte de l'annonce
CREATE TABLE IF NOT EXISTS announcements (
  trip       TEXT NOT NULL,
  id         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  send_at    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  done_at    INTEGER,
  PRIMARY KEY (trip, id)
);
CREATE INDEX IF NOT EXISTS idx_ann_due ON announcements (done_at, send_at);

CREATE TABLE IF NOT EXISTS deliveries (
  trip     TEXT NOT NULL,
  ann_id   TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status   INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (trip, ann_id, endpoint)
);
