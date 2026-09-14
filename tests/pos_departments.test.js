const test = require('node:test');
const assert = require('node:assert/strict');
const {
  departmentFromSubCategory,
  buildPosTickets,
  allPosTicketsReady,
  orderTouchesDepartment,
} = require('../lib/pos_departments');

test('maps shopping subcategories to POS departments', () => {
  assert.equal(departmentFromSubCategory('grocery'), 'grocery');
  assert.equal(departmentFromSubCategory('food_items'), 'grocery');
  assert.equal(departmentFromSubCategory('home_goods'), 'household');
  assert.equal(departmentFromSubCategory('shoes_bags'), '');
});

test('mixed cart builds two tickets and one order stays mixed', () => {
  const tickets = buildPosTickets({
    lineItems: [
      { posDepartment: 'grocery' },
      { subCategory: 'home_goods' },
    ],
  });
  assert.equal(tickets.grocery.status, 'pending');
  assert.equal(tickets.household.status, 'pending');
  assert.equal(allPosTicketsReady({ posTickets: tickets }), false);
  tickets.grocery.status = 'ready';
  tickets.household.status = 'ready';
  assert.equal(allPosTicketsReady({ posTickets: tickets }), true);
  assert.equal(orderTouchesDepartment({ posTickets: tickets }, 'grocery'), true);
  assert.equal(orderTouchesDepartment({ posTickets: { grocery: { status: 'pending' } } }, 'household'), false);
});
