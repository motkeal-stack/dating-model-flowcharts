# Personal Flows

ברוך הבא לריפו של התזרים (Flows) האישיים שלי!
כאן מרוכזים כל מסמכי התזרים, התרשימים וקטעי הקוד הקשורים לתהליכים שונים שאני בונה.

## Flow Studio
הריפו כולל עכשיו גם `Mermaid Flow Studio`.
כל קבצי האפליקציה מרוכזים בתיקייה ייעודית:
- `C:\Users\alroy\projects\personal-flows\mermaid-flow-studio`

בתוך התיקייה הזאת יש:
- UI מקומי עם תצוגת Mermaid חיה, עורך קוד, outline ועריכה נקודתית.
- שרת Node + TypeScript עם API מקומי ושרת MCP ל-ChatGPT App.
- `package.json`, `src`, `dist`, `node_modules` וסקריפטי ההפעלה.

קבצי `.mmd` האישיים נשארים ברמת הריפו כדי להמשיך להיות ספריית ה-flows שלך.

## איך להפעיל
- לעבור לתיקיית `mermaid-flow-studio`
- לפתיחה מהירה: `open_studio.bat`
- לפתיחת תזרים ספציפי: `open_studio.bat דייטינג`
- להפעלה ידנית:
  - `npm run build`
  - `npm run dev`
  - לפתוח `http://127.0.0.1:3210/`

## קבצים קיימים
- `viewer.html` ו-`open_viewer.*` נשארו זמינים כ-viewer הישן.
- הסטודיו החדש יושב תחת `mermaid-flow-studio/src/server`, `mermaid-flow-studio/src/web`, `mermaid-flow-studio/src/shared`.
