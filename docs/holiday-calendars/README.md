# Holiday calendars

`bangladesh-2026.csv` is the **provisional** working calendar for leave counting, adopted by the System Owner on 2026-10-17 until Brain Station 23's own approved calendar is available.

- **Jurisdiction:** Bangladesh (government public holidays, general and executive-order).
- **Timezone:** Asia/Dhaka.
- **Supported years:** 2026.
- **Working week:** Monday to Friday. Saturday and Sunday are weekends, matching `src/domain/leave.ts`, so holidays that fall on a weekend do not change any working-day count.
- **Columns:** `date` (ISO, Asia/Dhaka calendar date), `name`, and `kind` (`general`, `executive order` or `special`).

## Sources and caveats

- **Sources.** The list follows the Ministry of Public Administration notification of 9 November 2025: 14 general holidays plus 14 executive-order holidays. It is cross-checked against holidaydb.com and press reports (The Daily Star, Prothom Alo, TBS).
- **Durga Puja.** 22 October was added by the Cabinet on 5 October 2026.
- **Eid-ul-Azha.** Uses the official 26–31 May window. holidaydb.com also lists 25 May; that date is not included here.
- **Moon sighting.** Islamic holidays can move by a day. Adjust them if the government reschedules.

## Adjusting it

The calendar is data, not code. Story 5.1 lets the Administrator load a calendar file like this one. Every load is stored as a new **version**, so past leave counts stay explainable. To change a date:

1. Edit this file, or make a corrected copy.
2. Load it again in the app.

To add a year, add a new file (for example `bangladesh-2027.csv`) once that year's government list is published. Dates outside the supported years fail with `UNSUPPORTED_YEAR`; they are never guessed.
