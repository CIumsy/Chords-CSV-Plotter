# Chords-CSV-Plotter
A web based CSV signal plotter with FFT. Upload your csv file, enter the sampling rate(optional) and visualize your data.

## Running it
No build step. Open `index.html` directly in a browser, or serve the folder with any static file server.

## Project structure
```
index.html   Markup only.
style.css     All styling, grouped under short section comments:
              base styles (colors/fonts/resets) -> layout (topbar, sidebar,
              plot, FFT panel, modal, responsive) -> onboarding tour.
script.js     All logic, in 9 sections, in the order it actually runs:
              state/helpers -> theme -> csv loading -> channel lists ->
              controls -> plot drawing -> FFT drawing -> render loop &
              startup -> onboarding tour.
```
`style.css` and `script.js` open with a short section map. Search for words such as `Controls`,
`Main plot`, or `Minimap` to find related code. Shared colors and fonts are CSS variables near the top of
`style.css`; change them there instead of editing each component.
