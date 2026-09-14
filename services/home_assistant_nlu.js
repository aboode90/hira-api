/**
 * مساعد حيرة — فهم النوايا (NLU) بدون LLM.
 * يدعم العربية العراقية، خطوات المحادثة، التأكيد، وتكرار آخر طلب.
 */

const YES_WORDS = [
  'نعم',
  'اي',
  'أيوه',
  'ايوه',
  'صح',
  'أكيد',
  'اكيد',
  'تمام',
  'موافق',
  'اوك',
  'ok',
  'yes',
  'يب',
  'ايه',
  'صحيح',
  'بالضبط',
  'ماشي',
  'امشي',
];

const NO_WORDS = [
  'لا',
  'لأ',
  'مو',
  'ما',
  'غير',
  'الغ',
  'إلغاء',
  'الغاء',
  'cancel',
  'no',
  'مو موافق',
  'مش موافق',
];

const REPEAT_WORDS = [
  'نفس',
  'كرر',
  'مرة ثانية',
  'مره ثانيه',
  'آخر طلب',
  'اخر طلب',
  'نفس الشي',
  'نفس الشيء',
  'نفس الطلب',
  'repeat',
  'again',
];

function normalizeArabic(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ');
}

function containsAny(text, words) {
  return words.some((word) => text.includes(normalizeArabic(word)));
}

function hasRideVerb(text) {
  return containsAny(text, RIDE_VERBS);
}

const TAXI_WORDS = ['تكسي', 'تاكسي', 'سياره', 'سيارة', 'مشوار', 'تاكس', 'taxi'];
const FOOD_WORDS = [
  'اكل',
  'أكل',
  'طعام',
  'مطعم',
  'مطاعم',
  'وجبه',
  'وجبة',
  'جوع',
  'غدا',
  'عشا',
  'فطور',
  'restaurant',
  'food',
];
const SHOPPING_WORDS = [
  'تسوق',
  'شراء',
  'متجر',
  'منتج',
  'بضاعه',
  'بضاعة',
  'shop',
  'store',
];
const DELIVERY_WORDS = [
  'توصيل',
  'طرد',
  'ارسال',
  'أرسل',
  'ارسل',
  'دليفري',
  'delivery',
  'parcel',
];
const RIDE_VERBS = [
  'وديني',
  'خذني',
  'وصلني',
  'نوصلني',
  'اوصلني',
  'أوصلني',
  'جيبني',
  'بلغني',
  'روحني',
];

const INSIDE_CITY_WORDS = ['داخل', 'قريب', 'مدينه', 'مدينة', 'محليه', 'محلية'];
const OUTSIDE_CITY_WORDS = ['خارج', 'بعيد', 'محافظه', 'محافظة', 'طريق', 'سفر'];
const CURRENT_LOCATION_WORDS = [
  'حالي',
  'الحالي',
  'موقعي',
  'هنا',
  'مكاني',
  'موقع الحالي',
  'current',
  'gps',
];
const OTHER_LOCATION_WORDS = [
  'اخر',
  'آخر',
  'غير',
  'مكان اخر',
  'مكان آخر',
  'موقع اخر',
  'موقع آخر',
  'موقع مختلف',
  'other',
  'different',
];
const GRILL_WORDS = ['مشاوي', 'مشوي', 'مشويات', 'شوي', 'grill'];
const FAST_FOOD_WORDS = ['وجبات', 'سريع', 'سريعه', 'سريعة', 'fast food', 'fast'];

function detectIntent(text) {
  const hasFood = containsAny(text, FOOD_WORDS);
  const hasShopping = containsAny(text, SHOPPING_WORDS);
  const hasDelivery = containsAny(text, DELIVERY_WORDS);
  const hasTaxi = containsAny(text, TAXI_WORDS);
  const rideVerb = hasRideVerb(text);

  if (hasFood && (!rideVerb || containsAny(text, FOOD_WORDS))) return 'food';
  if (hasShopping) return 'shopping';
  if (hasDelivery) return 'delivery';
  if (hasTaxi || rideVerb) return 'taxi';
  return 'unknown';
}

function hasExplicitTaxiCity(text) {
  return containsAny(text, INSIDE_CITY_WORDS) || containsAny(text, OUTSIDE_CITY_WORDS);
}

function detectInsideCity(text) {
  if (containsAny(text, INSIDE_CITY_WORDS)) return true;
  if (containsAny(text, OUTSIDE_CITY_WORDS)) return false;
  return null;
}

function detectPickupSource(text) {
  if (containsAny(text, CURRENT_LOCATION_WORDS)) return 'current';
  if (containsAny(text, OTHER_LOCATION_WORDS)) return 'other';
  return null;
}

function detectCuisine(text) {
  if (containsAny(text, GRILL_WORDS)) return 'grills';
  if (containsAny(text, FAST_FOOD_WORDS)) return 'fast_food';
  return null;
}

function choice(id, label, primary = true) {
  return { id, label, primary };
}

function reply(message, options = {}) {
  return {
    reply: message,
    step: options.step ?? null,
    choices: options.choices ?? [],
    session: options.session ?? {},
    action: options.action ?? null,
    speak: options.speak !== false,
  };
}

function cloneSession(session = {}) {
  return {
    step: session.step ?? null,
    lastIntent: session.lastIntent ?? null,
    lastAction: session.lastAction ?? null,
    taxiInsideCity: session.taxiInsideCity ?? null,
    pendingConfirmation: session.pendingConfirmation ?? null,
  };
}

function rememberIntent(session, intent, action = null) {
  const next = cloneSession(session);
  next.lastIntent = intent;
  if (action) next.lastAction = action;
  next.pendingConfirmation = null;
  return next;
}

function handleConfirmation(text, session) {
  const pending = session.pendingConfirmation;
  if (!pending) return null;

  if (containsAny(text, YES_WORDS)) {
    const next = cloneSession(session);
    next.pendingConfirmation = null;
    if (pending.kind === 'inside_city') {
      next.taxiInsideCity = true;
      next.step = 'taxi_pickup';
      return reply('تمام، تكسي داخل المدينة. من موقعك الحالي أم موقع آخر؟', {
        step: 'taxi_pickup',
        choices: [
          choice('pickup_current', 'موقعي الحالي'),
          choice('pickup_other', 'موقع آخر', false),
        ],
        session: next,
      });
    }
    if (pending.kind === 'outside_city') {
      next.taxiInsideCity = false;
      next.step = 'taxi_pickup';
      return reply('تمام، تكسي خارج المدينة. من موقعك الحالي أم موقع آخر؟', {
        step: 'taxi_pickup',
        choices: [
          choice('pickup_current', 'موقعي الحالي'),
          choice('pickup_other', 'موقع آخر', false),
        ],
        session: next,
      });
    }
    if (pending.kind === 'repeat_last') {
      if (!session.lastAction) {
        return reply('لا يوجد طلب سابق لأكرره. ماذا تريد؟', {
          choices: defaultChoices(),
          session: next,
        });
      }
      return reply('حسناً، أكرر آخر طلب لك.', {
        session: rememberIntent(next, session.lastIntent, session.lastAction),
        action: session.lastAction,
      });
    }
  }

  if (containsAny(text, NO_WORDS)) {
    const next = cloneSession(session);
    next.pendingConfirmation = null;
    if (pending.kind === 'inside_city' || pending.kind === 'outside_city') {
      next.step = 'taxi_city';
      return reply('تكسي داخل المدينة (حتى 15 كم) أم خارج المدينة؟', {
        step: 'taxi_city',
        choices: [
          choice('inside_city', 'داخل المدينة'),
          choice('outside_city', 'خارج المدينة', false),
        ],
        session: next,
      });
    }
    return reply('حسناً، ماذا تريد بدلاً من ذلك؟', {
      choices: defaultChoices(),
      session: next,
    });
  }

  return reply('هل تقصد نعم أم لا؟', {
    choices: [choice('confirm_yes', 'نعم'), choice('confirm_no', 'لا', false)],
    session: cloneSession(session),
  });
}

function defaultChoices() {
  return [
    choice('intent_taxi', 'تكسي'),
    choice('intent_food', 'أكل', false),
    choice('intent_shopping', 'تسوق', false),
    choice('intent_delivery', 'توصيل', false),
  ];
}

function startTaxiFlow(session, insideCity = null) {
  const next = cloneSession(session);
  if (insideCity === true) {
    next.taxiInsideCity = true;
    next.step = 'taxi_pickup';
    return reply('تكسي داخل المدينة. من موقعك الحالي أم موقع آخر؟', {
      step: 'taxi_pickup',
      choices: [
        choice('pickup_current', 'موقعي الحالي'),
        choice('pickup_other', 'موقع آخر', false),
      ],
      session: rememberIntent(next, 'taxi'),
    });
  }
  if (insideCity === false) {
    next.taxiInsideCity = false;
    next.step = 'taxi_pickup';
    return reply('تكسي خارج المدينة. من موقعك الحالي أم موقع آخر؟', {
      step: 'taxi_pickup',
      choices: [
        choice('pickup_current', 'موقعي الحالي'),
        choice('pickup_other', 'موقع آخر', false),
      ],
      session: rememberIntent(next, 'taxi'),
    });
  }
  next.step = 'taxi_city';
  return reply('تكسي داخل المدينة (حتى 15 كم) أم خارج المدينة؟', {
    step: 'taxi_city',
    choices: [
      choice('inside_city', 'داخل المدينة'),
      choice('outside_city', 'خارج المدينة', false),
    ],
    session: rememberIntent(next, 'taxi'),
  });
}

function openTaxiAction(session, useCurrentLocation) {
  const insideCity = session.taxiInsideCity !== false;
  const action = {
    type: 'open_taxi',
    params: {
      insideCityTrip: insideCity,
      autoPickupFromCurrentLocation: useCurrentLocation,
    },
  };
  const next = rememberIntent(session, 'taxi', action);
  next.step = null;
  next.taxiInsideCity = null;
  return reply(
    useCurrentLocation
      ? 'تمام. فتحت لك طلب التكسي وحدّدت موقعك كنقطة انطلاق — اختر وجهتك.'
      : 'تمام. حدّد نقطة الانطلاق والوجهة على الخريطة.',
    { session: next, action },
  );
}

function startFoodFlow(session, cuisine = null) {
  if (cuisine === 'grills' || cuisine === 'fast_food') {
    const action = {
      type: 'open_food',
      params: { cuisineFilter: cuisine },
    };
    const label = cuisine === 'grills' ? 'مشاوي' : 'وجبات سريعة';
    const next = rememberIntent(session, 'food', action);
    next.step = null;
    return reply('حسناً، هذه المطاعم المسجّلة — $label.', {
      session: next,
      action,
    });
  }
  const next = cloneSession(session);
  next.step = 'food_cuisine';
  return reply('هل تريد مشاوي أم وجبات سريعة؟', {
    step: 'food_cuisine',
    choices: [
      choice('food_grills', 'مشاوي'),
      choice('food_fast', 'وجبات سريعة', false),
    ],
    session: rememberIntent(next, 'food'),
  });
}

function handleStep(text, session) {
  const step = session.step;

  if (step === 'taxi_city') {
    if (containsAny(text, INSIDE_CITY_WORDS)) {
      return startTaxiFlow(session, true);
    }
    if (containsAny(text, OUTSIDE_CITY_WORDS)) {
      return startTaxiFlow(session, false);
    }
    return startTaxiFlow(session, null);
  }

  if (step === 'taxi_pickup') {
    const pickup = detectPickupSource(text);
    if (pickup === 'current') return openTaxiAction(session, true);
    if (pickup === 'other') return openTaxiAction(session, false);
    return reply('من موقعك الحالي أم موقع آخر؟', {
      step: 'taxi_pickup',
      choices: [
        choice('pickup_current', 'موقعي الحالي'),
        choice('pickup_other', 'موقع آخر', false),
      ],
      session: cloneSession(session),
    });
  }

  if (step === 'food_cuisine') {
    const cuisine = detectCuisine(text);
    if (cuisine) return startFoodFlow(session, cuisine);
    return startFoodFlow(session, null);
  }

  return null;
}

function handleChoiceId(choiceId, session) {
  switch (choiceId) {
    case 'inside_city':
      return startTaxiFlow(session, true);
    case 'outside_city':
      return startTaxiFlow(session, false);
    case 'pickup_current':
      return openTaxiAction(session, true);
    case 'pickup_other':
      return openTaxiAction(session, false);
    case 'food_grills':
      return startFoodFlow(session, 'grills');
    case 'food_fast':
      return startFoodFlow(session, 'fast_food');
    case 'intent_taxi':
      return startTaxiFlow(session, null);
    case 'intent_food':
      return startFoodFlow(session, null);
    case 'intent_shopping': {
      const action = { type: 'open_shopping', params: {} };
      const next = rememberIntent(session, 'shopping', action);
      return reply('حسناً، سأفتح لك التسوق.', { session: next, action });
    }
    case 'intent_delivery': {
      const action = {
        type: 'open_taxi',
        params: { insideCityTrip: true, autoPickupFromCurrentLocation: true },
      };
      const next = rememberIntent(session, 'delivery', action);
      return reply('حسناً، سأفتح لك طلب التوصيل.', { session: next, action });
    }
    case 'confirm_yes':
      return handleConfirmation('نعم', session);
    case 'confirm_no':
      return handleConfirmation('لا', session);
    default:
      return null;
  }
}

function handleRepeat(session) {
  if (!session.lastAction) {
    return reply('لا يوجد طلب سابق. ماذا تريد؟', {
      choices: defaultChoices(),
      session: cloneSession(session),
    });
  }
  const next = cloneSession(session);
  next.pendingConfirmation = { kind: 'repeat_last' };
  const label = session.lastIntent === 'food'
    ? 'طلب الأكل'
    : session.lastIntent === 'shopping'
      ? 'التسوق'
      : session.lastIntent === 'delivery'
        ? 'التوصيل'
        : 'التكسي';
  return reply(`هل تريد تكرار آخر طلب ($label)؟`, {
    choices: [choice('confirm_yes', 'نعم'), choice('confirm_no', 'لا', false)],
    session: next,
  });
}

function parseAssistantUtterance(rawText, session = {}, options = {}) {
  const text = normalizeArabic(rawText);
  if (!text) {
    return reply('لم أسمع شيئاً. جرّب مرة أخرى.', {
      choices: defaultChoices(),
      session: cloneSession(session),
    });
  }

  if (options.choiceId) {
    const fromChoice = handleChoiceId(options.choiceId, session);
    if (fromChoice) return fromChoice;
  }

  const confirmation = handleConfirmation(text, session);
  if (confirmation) return confirmation;

  const stepResult = handleStep(text, session);
  if (stepResult) return stepResult;

  if (containsAny(text, REPEAT_WORDS)) {
    return handleRepeat(session);
  }

  const intent = detectIntent(text);
  const insideCity = detectInsideCity(text);
  const pickup = detectPickupSource(text);
  const cuisine = detectCuisine(text);

  if (intent === 'taxi') {
    if (insideCity === true && pickup == null) {
      const next = cloneSession(session);
      next.pendingConfirmation = { kind: 'inside_city' };
      return reply('هل تقصد تكسي داخل المدينة (حتى 15 كم)؟', {
        choices: [choice('confirm_yes', 'نعم'), choice('confirm_no', 'لا', false)],
        session: rememberIntent(next, 'taxi'),
      });
    }
    if (insideCity === false && pickup == null) {
      const next = cloneSession(session);
      next.pendingConfirmation = { kind: 'outside_city' };
      return reply('هل تقصد تكسي خارج المدينة؟', {
        choices: [choice('confirm_yes', 'نعم'), choice('confirm_no', 'لا', false)],
        session: rememberIntent(next, 'taxi'),
      });
    }
    if (insideCity != null || pickup != null) {
      const next = rememberIntent(cloneSession(session), 'taxi');
      if (insideCity != null) next.taxiInsideCity = insideCity;
      if (pickup != null) {
        next.step = null;
        return openTaxiAction(
          { ...next, taxiInsideCity: insideCity ?? next.taxiInsideCity ?? true },
          pickup === 'current',
        );
      }
      return startTaxiFlow(next, insideCity);
    }
    return startTaxiFlow(session, null);
  }

  if (intent === 'food') {
    return startFoodFlow(session, cuisine);
  }

  if (intent === 'shopping') {
    const action = { type: 'open_shopping', params: {} };
    const next = rememberIntent(session, 'shopping', action);
    return reply('حسناً، سأفتح لك التسوق.', { session: next, action });
  }

  if (intent === 'delivery') {
    const action = {
      type: 'open_taxi',
      params: { insideCityTrip: true, autoPickupFromCurrentLocation: true },
    };
    const next = rememberIntent(session, 'delivery', action);
    return reply('حسناً، سأفتح لك طلب التوصيل.', { session: next, action });
  }

  return reply('لم أفهم الطلب بوضوح. جرّب: تكسي، أكل، تسوق، أو توصيل.', {
    choices: defaultChoices(),
    session: cloneSession(session),
  });
}

module.exports = {
  parseAssistantUtterance,
  normalizeArabic,
  detectIntent,
};
