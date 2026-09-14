const {
  isBase64Image,
  stripBase64Deep,
  serializeProductRowForClient,
} = require('../services/image_refs');

describe('image_refs — product descriptions must not be stripped', () => {
  const longArabicDescription =
    'منتج غذائي طازج محضّر يومياً من أجود المكونات الطبيعية، مناسب للعوائل ويُقدَّم ساخناً مع صلصة خاصة. ' +
    'الكمية تكفي لشخصين إلى ثلاثة أشخاص، ويمكن إضافة خضار أو أرز حسب الطلب. التوصيل متاح داخل المدينة خلال ساعة.';

  test('long Arabic text is not treated as a base64 image', () => {
    expect(longArabicDescription.length).toBeGreaterThan(120);
    expect(isBase64Image(longArabicDescription)).toBe(false);
  });

  test('PNG / JPEG magic headers are still detected as images', () => {
    expect(isBase64Image('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')).toBe(true);
    expect(isBase64Image('/9j/4AAQSkZJRgABAQAAAQABAAD')).toBe(true);
  });

  test('serializeProductRowForClient keeps long description_ar', () => {
    const row = {
      id: '1',
      name_ar: 'وجبة عائلية كبيرة',
      description_ar: longArabicDescription,
      description_en: 'A'.repeat(200),
      image: 'https://cdn.example.com/food.jpg',
      price: 5000,
    };
    const out = serializeProductRowForClient(row);
    expect(out.description_ar).toBe(longArabicDescription);
    expect(out.description_en).toBe('A'.repeat(200));
    expect(out.name_ar).toBe('وجبة عائلية كبيرة');
  });

  test('stripBase64Deep never blanks text field keys', () => {
    const out = stripBase64Deep({
      description_ar: longArabicDescription,
      image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    });
    expect(out.description_ar).toBe(longArabicDescription);
    expect(out.image).toBe('');
  });
});
