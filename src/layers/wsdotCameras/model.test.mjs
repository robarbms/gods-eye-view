import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsdotCameras } from './model.js';

const camera = (overrides = {}) => ({
  CameraID: 9818,
  Title: 'I-5 at NE 45th St',
  Description: null,
  DisplayLatitude: 47.66,
  DisplayLongitude: -122.32,
  ImageURL: 'https://images.wsdot.wa.gov/nw/005vc00000.jpg',
  IsActive: true,
  Region: 'Northwest',
  CameraOwner: null,
  CameraLocation: {
    RoadName: '005',
    MilePost: 169.0,
    Latitude: 47.66,
    Longitude: -122.32,
    Description: null,
  },
  ...overrides,
});

test('normalizes active cameras with finite coordinates and a snapshot URL', () => {
  const records = normalizeWsdotCameras({ cameras: [camera()] });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    id: '9818',
    title: 'I-5 at NE 45th St',
    road: '005',
    milepost: 169.0,
    lat: 47.66,
    lon: -122.32,
    imageUrl: 'https://images.wsdot.wa.gov/nw/005vc00000.jpg',
    description: null,
    owner: null,
    region: 'Northwest',
  });
});

test('accepts a bare array payload and falls back to CameraLocation coordinates', () => {
  const records = normalizeWsdotCameras([
    camera({
      DisplayLatitude: null,
      DisplayLongitude: undefined,
      CameraLocation: {
        RoadName: '090',
        Latitude: 47.6,
        Longitude: -120.5,
      },
    }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].lat, 47.6);
  assert.equal(records[0].lon, -120.5);
  assert.equal(records[0].road, '090');
});

test('drops inactive, coordinate-less, image-less, and out-of-range cameras', () => {
  const records = normalizeWsdotCameras({
    cameras: [
      camera({ CameraID: 1, IsActive: false }),
      camera({ CameraID: 2, DisplayLatitude: null, CameraLocation: {} }),
      camera({ CameraID: 3, ImageURL: '   ' }),
      camera({ CameraID: 4, DisplayLatitude: 120 }),
      camera({ CameraID: 5 }),
    ],
  });
  assert.deepEqual(
    records.map((r) => r.id),
    ['5'],
  );
});

test('de-duplicates by CameraID and titles a nameless camera', () => {
  const records = normalizeWsdotCameras([
    camera({ CameraID: 7, Title: null, CameraLocation: { Description: 'Pass' } }),
    camera({ CameraID: 7 }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'Pass');
});

test('returns null for an unrecognizable payload', () => {
  assert.equal(normalizeWsdotCameras(null), null);
  assert.equal(normalizeWsdotCameras({}), null);
  assert.equal(normalizeWsdotCameras(42), null);
});
