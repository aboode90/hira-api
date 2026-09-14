const test = require('node:test');
const assert = require('node:assert/strict');
const {
  trimRouteNearDestination,
  haversineDistanceMeters,
} = require('../lib/route_destination_trim');

function point(lat, lng) {
  return { latitude: lat, longitude: lng };
}

test('trimRouteNearDestination cuts U-turn tail when route passes near destination', () => {
  const destination = point(33.0, 44.0);
  const approach = point(32.999, 43.9995);
  const away = point(32.9985, 43.999);
  const uTurn = point(32.998, 44.001);
  const back = point(33.0, 44.0);

  const approachDistance = haversineDistanceMeters(approach, destination);
  assert.ok(approachDistance <= 200);

  const originalPoints = [point(32.997, 43.998), approach, away, uTurn, back];
  const originalDistance = 1800;

  const result = trimRouteNearDestination(originalPoints, destination, {
    distanceMeters: originalDistance,
    durationSeconds: 600,
  });

  assert.equal(result.trimmed, true);
  assert.ok(result.distanceMeters < originalDistance);
  assert.ok(result.distanceMeters < 600);
  assert.equal(result.points.at(-1).latitude, destination.latitude);
  assert.equal(result.points.at(-1).longitude, destination.longitude);
});

test('trimRouteNearDestination keeps full route when never near destination', () => {
  const destination = point(33.1, 44.1);
  const points = [point(33.0, 44.0), point(33.02, 44.02), point(33.04, 44.04)];

  const result = trimRouteNearDestination(points, destination, {
    distanceMeters: 5000,
    durationSeconds: 900,
  });

  assert.equal(result.trimmed, false);
  assert.equal(result.distanceMeters, 5000);
  assert.equal(result.durationSeconds, 900);
});
