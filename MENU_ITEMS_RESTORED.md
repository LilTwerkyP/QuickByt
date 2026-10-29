# Restored menu entries

The repository version pushed to GitHub had 38 actual menu entries. Its HTML contained image-override keys for additional dishes, but it did not contain those items in `INITIAL_MENU_ITEMS` or `backend/menu_seed.json`. This patch restores those entries in both places so the frontend and database stay aligned.

**Important: prices for newly restored dishes are provisional estimates**, because the source copy in the repository did not contain their prices. Review and replace these values in both `frontend/index.html` and `backend/menu_seed.json` before using the site for real orders. Prices in this file: Aloo Paratha ₹40; Paneer Paratha ₹60; Plain Paratha ₹25; Egg Bhurji ₹60; Egg Fried Rice ₹90; Veg Fried Rice ₹70; Paneer Fried Rice ₹90; Paneer Noodles ₹80; Chicken Noodles ₹100; Paneer Chilli ₹100; Veg Manchurian ₹80; Egg Curry ₹80; Chicken Chilli ₹120; Egg Roll ₹50; Veg Roll ₹45; Paneer Roll ₹65; Peri Peri Fries ₹60; French Fries ₹50; Crispy Corn ₹80.

These rows use the existing image resolver keys so the image assets already embedded in `frontend/index.html` can be displayed. On an existing database, the server seed inserts new IDs on startup and preserves each existing item's stock flag.
