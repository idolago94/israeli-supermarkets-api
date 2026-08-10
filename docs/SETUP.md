# הגדרת שירות הקטלוג — מה צריך להגדיר כדי שהכל יעבוד

מסמך זה מרכז את **כל** ההגדרות הנדרשות כדי שהקטלוג יעבוד מקצה לקצה: מסד הנתונים
(MongoDB Atlas), הפריסה (Vercel), והמתזמן (GitHub Actions). צד האפליקציה מתועד
בריפו של האפליקציה — [`marketing-app`](https://github.com/idolago94/marketing-app).

## מפת הרכיבים

```
GitHub Actions (cron)                           ← המתזמן: מתי לסנכרן
   │  POST /api/sync/{full|deltas}?chain=…  (x-sync-secret)
   ▼
השירות הזה (Vercel)                             ← סנכרון + שליפה
   │  scrape Cerberus → parse → upsert / read
   ▼
MongoDB Atlas                                   ← האחסון: products, syncState
   ▲
   │  GET /api/products/*  (x-api-key)
Expo app                                        ← הצרכן: חיפוש והשוואת מחירים
```

שלושה דברים צריך להגדיר, לפי הסדר: **MongoDB → Vercel → GitHub Actions**
(ואז המפתחות באפליקציה).

> **מה השתנה:** בעבר המתזמן היה פונקציות Firebase מתוזמנות
> (`syncCatalogFull` / `syncCatalogDeltas`) שישבו בריפו של האפליקציה ודרשו תוכנית
> **Blaze**. המתזמן עבר לכאן, ל-GitHub Actions, ואותן פונקציות הוסרו מ-Firebase.

---

## 1. MongoDB Atlas

1. צור חשבון ב-[mongodb.com/atlas](https://www.mongodb.com/atlas) וצור **Cluster**
   (שכבת **M0** החינמית מספיקה — הקטלוג ~50MB).
2. **Database Access** → צור משתמש DB עם סיסמה (הרשאת `readWrite`).
3. **Network Access** → הוסף כתובות IP שמורשות להתחבר. Vercel לא מפרסמת טווח IP
   קבוע בתוכניות הרגילות, ולכן בפועל מגדירים `0.0.0.0/0` (גישה מכל מקום) —
   האבטחה מסתמכת על סיסמת ה-DB החזקה ועל ה-`MONGODB_URI` הסודי. (בתוכנית Vercel
   עם Static IP אפשר לצמצם לטווח ספציפי.)
4. **Connect → Drivers** → העתק את מחרוזת החיבור (SRV), למשל:
   ```
   mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
   ```
5. בחר שם מסד נתונים, למשל `catalog` (ישמש כ-`MONGODB_DB`).

> אין צורך ליצור collections או אינדקסים ידנית — `lib/mongo.ts` יוצר את
> האינדקסים אוטומטית בריצה הראשונה.

---

## 2. פריסה על Vercel

הריפו הזה **הוא** השירות, כך שאין צורך להגדיר Root Directory.

1. ייבא את הריפו ב-[vercel.com/new](https://vercel.com/new) (או `vercel link`
   מהתיקייה הזו).
2. **Settings → Environment Variables** — הגדר:

   | משתנה | ערך |
   |---|---|
   | `MONGODB_URI` | מחרוזת החיבור משלב 1 |
   | `MONGODB_DB` | `catalog` (או השם שבחרת) |
   | `CATALOG_API_KEY` | מחרוזת אקראית ארוכה — האפליקציה שולחת אותה ב-`x-api-key` |
   | `SYNC_SECRET` | מחרוזת אקראית ארוכה **אחרת** — נדרשת כדי להפעיל סנכרון |

   ליצירת מחרוזת אקראית: `openssl rand -hex 32`.
3. פרוס (`vercel --prod`, או פשוט push ל-`main` אחרי הייבוא). שמור את כתובת
   ה-production, למשל `https://israeli-supermarkets-api.vercel.app` — נזדקק לה בשלבים 3 ו-4.

הגדרות ה-`maxDuration`/memory לפונקציות הסנכרון כבר מוגדרות ב-`vercel.json`.

---

## 3. GitHub Actions — המתזמן

התזמון יושב ב-[`.github/workflows/catalog-sync.yml`](../.github/workflows/catalog-sync.yml)
שבריפו הזה. אין בו לוגיקת קטלוג — הוא רק קורא ל-`/api/sync/*`.

1. **Settings → Secrets and variables → Actions → New repository secret**,
   הוסף שני סודות:

   | סוד | ערך |
   |---|---|
   | `CATALOG_API_BASE` | כתובת הפריסה משלב 2, בלי `/` בסוף |
   | `SYNC_SECRET` | **אותו ערך בדיוק** כמו `SYNC_SECRET` ב-Vercel |

   > **חשוב:** אם הערכים לא זהים — ה-API יחזיר 401.
2. זהו. ה-workflow ירוץ לפי הזמנים הבאים:

   | ריצה | שעה (Asia/Jerusalem, שעון חורף) | cron (UTC) | פעולה |
   |---|---|---|---|
   | סנכרון מלא | כל לילה 03:00 | `0 1 * * *` | `POST /api/sync/full?chain=<id>` |
   | סנכרוני דלתא | 07:00, 11:00, 15:00, 19:00 | `0 5,9,13,17 * * *` | `POST /api/sync/deltas?chain=<id>` |

   ה-cron של GitHub מוגדר ב-UTC בלבד, ולכן השעות למעלה הן שעון **חורף** בישראל
   (UTC+2); בשעון קיץ כל ריצה תתרחש שעה מאוחר יותר מקומית — לא משנה לרענון קטלוג.

   כל ריצה מפעילה את הרשתות **אחת אחרי השנייה** (`?chain=<id>`), כדי שכל קריאה
   תישאר הרחק מתקרת ה-300 שניות ורשת שנכשלת לא תפיל את השאר.
3. **הרצה ידנית:** Actions → *catalog sync* → *Run workflow*, עם בחירת `mode`
   (`full`/`deltas`), `chain`, ו-`force`. זה מחליף את פונקציית ה-HTTP הישנה
   `syncCatalogNow`.

> GitHub משבית workflows מתוזמנים בריפו שלא הייתה בו פעילות 60 יום. אם זה קורה,
> מפעילים מחדש מלשונית Actions.

לשינוי התדירות/שעות — ערוך את שורות ה-`cron:` ב-workflow.

---

## 4. האפליקציה (Expo)

בריפו של האפליקציה, הוסף ל-`.env`:

```
EXPO_PUBLIC_CATALOG_API_BASE=https://israeli-supermarkets-api.vercel.app
EXPO_PUBLIC_CATALOG_API_KEY=<אותו-ערך-כמו-CATALOG_API_KEY-ב-Vercel>
```

`lib/products.ts` קורא אותם ושולח את המפתח ב-`x-api-key` בכל בקשה. בנה מחדש את
האפליקציה (או `expo start -c` לניקוי cache).

---

## 5. הזרעה ראשונית ובדיקה

לאחר הפריסה, מלא את הקטלוג פעם אחת (ב-MongoDB אין תקרת כתיבות יומית) — הכי פשוט
דרך ההרצה הידנית של ה-workflow (שלב 3.3, `mode: full`, `chain: all`), או ידנית:

```bash
# כל הרשתות בבת אחת:
curl -X POST -H "x-sync-secret: <SYNC_SECRET>" \
  "https://israeli-supermarkets-api.vercel.app/api/sync/full"
```

בדיקות שפיות:

```bash
# קריאה כמו שהאפליקציה עושה (צריך להחזיר מוצרים):
curl -H "x-api-key: <CATALOG_API_KEY>" \
  "https://israeli-supermarkets-api.vercel.app/api/products/search?q=חלב"

# בלי מפתח → 401:
curl -i "https://israeli-supermarkets-api.vercel.app/api/products/search?q=חלב"
```

באפליקציה: הקלד שם מוצר במודל "הוסף פריט" — אמורות להופיע הצעות עם מחירים.

---

## 6. מסך האדמין — עריכת מחלקות מוצרים

לצד ה-API, השירות מגיש מסך ניהול סטטי בכתובת **`/admin.html`**:

```
https://israeli-supermarkets-api.vercel.app/admin.html
```

המסך מציג את **כל** המוצרים בקטלוג עם **כל** המידע שנשמר (ברקוד, שם, מותג,
גודל, שדות מדידה, ומחירים לכל רשת כולל מחיר-ליחידת-מידה והאם מותרת הנחה),
ומאפשר לשייך לכל מוצר **מספר מחלקות** (`departments`) — לבחור ממחלקות קיימות
בדרופדאון או להוסיף מחלקה חדשה — ולשמור.

- **התחברות:** הדבק בשדה העליון את `CATALOG_API_KEY` (אותו מפתח שהאפליקציה
  משתמשת בו). הוא נשמר ב-`localStorage` של הדפדפן, כך שלא צריך להזין שוב.
- **עיון וחיפוש:** השאר את שדה החיפוש ריק ולחץ "טען" לעיון בכל הקטלוג עם
  "טען עוד", או הקלד שם מוצר (2+ תווים) לחיפוש ממוקד.
- **פילטרים:** אפשר לצמצם את הרשימה לפי **מחלקה** (כולל "ללא מחלקה"), לפי
  **סופר** (רשת), ולפי **שקיל** (נמכר במשקל / לא).
- **שמירה:** עריכת המחלקות נשלחת כ-`PATCH /api/products/:barcode` עם
  `{ departments: [...] }`. הוספת שבב לכל מחלקה, ולחיצה על ה-× מסירה. המחלקות
  **אינן** קיימות בקבצי המקור, ולכן הן שורדות כל סנכרון מחדש — הסנכרון לעולם
  לא דורס אותן.

> **הערה על אבטחה:** עדכון המחלקות מוגן באותו `CATALOG_API_KEY` של הקריאות (שכבר
> משובץ באפליקציה). אם חשוב לכם שכתיבות יהיו מוגבלות יותר, אפשר להסב את ה-PATCH
> לאימות `SYNC_SECRET`.

---

## 7. טבלת סיכום סודות (מי צריך להתאים למי)

| סוד | Vercel | GitHub Actions | App (`.env`) | חייב להתאים? |
|---|:---:|:---:|:---:|---|
| `MONGODB_URI` | ✅ | | | — |
| `MONGODB_DB` | ✅ | | | — |
| `CATALOG_API_KEY` | ✅ `CATALOG_API_KEY` | | ✅ `EXPO_PUBLIC_CATALOG_API_KEY` | **כן** — Vercel ↔ App |
| `SYNC_SECRET` | ✅ `SYNC_SECRET` | ✅ `SYNC_SECRET` | | **כן** — Vercel ↔ Actions |
| כתובת ה-API | (זו כתובת הפריסה) | ✅ `CATALOG_API_BASE` | ✅ `EXPO_PUBLIC_CATALOG_API_BASE` | אותה כתובת |

שני זוגות ה"חייב להתאים" הם נקודות הכשל הנפוצות ביותר. אם משהו מחזיר 401 —
תבדוק אותם קודם.

---

## 8. פתרון תקלות

| תסמין | סיבה סבירה |
|---|---|
| `/api/sync/*` מחזיר 401 | `SYNC_SECRET` ב-GitHub Actions ≠ `SYNC_SECRET` ב-Vercel |
| `/api/products/*` מחזיר 401 | `EXPO_PUBLIC_CATALOG_API_KEY` (app) ≠ `CATALOG_API_KEY` (Vercel) |
| שגיאת חיבור ל-Mongo בלוגים | `MONGODB_URI` שגוי, או ה-IP לא ב-Network Access |
| הקטלוג ריק אחרי סנכרון | הסנכרון עוד לא רץ — הרץ הזרעה ידנית (שלב 5), ובדוק את הלוגים של Vercel |
| ה-workflow המתוזמן לא רץ | הריפו לא היה פעיל 60 יום ו-GitHub השבית אותו, או שהסודות חסרים |
| סנכרון חוצה את 300 שניות | ה-workflow כבר קורא per-chain; אם רשת בודדת חוצה, פצל לפי סניף (`storeId`) או העלה את `maxDuration` |
| האפליקציה לא מוצאת מוצרים | לא בנית מחדש אחרי עדכון `.env`, או `EXPO_PUBLIC_CATALOG_API_BASE` שגוי |

היכן לראות לוגים:
- **Vercel:** Dashboard → Project → Deployments → Functions / Logs.
- **GitHub Actions:** לשונית Actions → *catalog sync* → הריצה האחרונה.
