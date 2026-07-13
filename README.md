# Chords-CSV-Plotter
A web based CSV signal plotter with FFT. Upload your csv file, enter the sampling rate(optional) and visualize your data.

## Running it
No build step. Open `index.html` directly in a browser, or serve the folder with any static file server.

## Project structure
```
index.html   Markup only.
style.css     All styling, in 3 sections (search for the ALL-CAPS headers):
              base styles (colors/fonts/resets) -> layout (topbar, sidebar,
              plot, FFT panel, modal, responsive) -> onboarding tour.
script.js     All logic, in 9 sections, in the order it actually runs:
              state/helpers -> theme -> csv loading -> channel lists ->
              controls -> plot drawing -> FFT drawing -> render loop &
              startup -> onboarding tour.
```
Both files open with a comment explaining their section map. To find where to make a change, search the
relevant file for its ALL-CAPS section header (e.g. "CONTROLS", "MAIN PLOT RENDERING") - each section has
its own short comment describing what it owns. Colors/fonts live as CSS variables at the top of style.css;
change them there rather than per-rule.
