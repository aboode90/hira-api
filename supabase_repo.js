/**
 * Supabase Repository — Legacy Compatibility Wrapper
 *
 * تم دمج جميع دوال قاعدة البيانات في وحدات منفصلة ضمن المجلد supabase_repo/
 * هذا الملف عبارة عن غلاف عكسي يُعيد تصدير كل شيء من supabase_repo/index.js
 * ليحافظ على التوافق مع الكود القديم.
 *
 * @deprecated استخدم require('./supabase_repo') مباشرة — فهو يحل تلقائياً إلى index.js
 * @see ./supabase_repo/index.js
 */
module.exports = require('./supabase_repo/index');
