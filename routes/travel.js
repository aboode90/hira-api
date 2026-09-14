const express = require('express');
const router = express.Router();

const { searchFlights, searchHotels, getHotelResults, getAffiliateUrl } = require('../services/travel_service');

/**
 * GET /api/travel/flights/search?origin=BGW&destination=IST&departDate=2026-08-01&returnDate=&passengers=1
 */
router.get('/flights/search', async (req, res) => {
  try {
    const data = await searchFlights({
      origin: String(req.query.origin || '').trim().toUpperCase(),
      destination: String(req.query.destination || '').trim().toUpperCase(),
      departDate: String(req.query.departDate || '').trim(),
      returnDate: String(req.query.returnDate || '').trim(),
      passengers: Number(req.query.passengers) || 1,
    });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Flight search failed.' });
  }
});

/**
 * GET /api/travel/hotels/search?query=Baghdad&checkIn=2026-08-01&checkOut=2026-08-05
 */
router.get('/hotels/search', async (req, res) => {
  try {
    const data = await searchHotels({
      query: String(req.query.query || '').trim(),
      checkIn: String(req.query.checkIn || '').trim(),
      checkOut: String(req.query.checkOut || '').trim(),
      adults: Number(req.query.adults) || 1,
    });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Hotel search failed.' });
  }
});

/**
 * GET /api/travel/hotels/results/:searchId
 */
router.get('/hotels/results/:searchId', async (req, res) => {
  try {
    const data = await getHotelResults(req.params.searchId, {});
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to get hotel results.' });
  }
});

/**
 * GET /api/travel/affiliate-url?type=flight&origin=BGW&destination=IST&departDate=...
 *     /api/travel/affiliate-url?type=hotel&locationId=12345&checkIn=...&checkOut=...
 */
router.get('/affiliate-url', (req, res) => {
  try {
    const type = String(req.query.type || '').trim();
    const url = getAffiliateUrl(type, req.query);
    return res.json({ url });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
