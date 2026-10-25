# Third-party notices

Jukelet's own code is [MIT licensed](LICENSE). Dependency licenses and Spotify
trademarks retain their own terms; MIT does not grant rights to Spotify content.
The app wheel/sdist include the MIT license and metadata; the container includes
`/app/LICENSE`. The built frontend includes [the React/React DOM/Scheduler MIT
copyright and license](frontend/public/third-party-notices.txt), accessible from
the app footer. Python dependencies retain installed `.dist-info` license files.
Review dependency changes and their distributed notices before each release.

## Spotify attribution asset

`frontend/public/spotify-logo-black.svg` is the **unmodified**
`Full_Logo_Black_RGB.svg` from Spotify's official full-logo download, accessed
2026-10-25 through the [Design & Branding Guidelines](https://developer.spotify.com/documentation/design).
It is a Spotify trademark used for required content attribution, separately from
Jukelet's branding, not an MIT-licensed Jukelet asset. It is displayed in its
original proportions, at 84px wide (above the 70px minimum), monochrome on the
light app background, with surrounding space and a link to the applicable content.

- Source: [official logo ZIP](https://developer.spotify.com/images/guidelines/design/2024-spotify-full-logo.zip)
- ZIP SHA-256: `b3d28ef2474a46b88aeb67c1449b522046003233a3df59e8e63582830101270f`
- SVG SHA-256: `b91219c14405166e3667deb7f250df4b939a8a5dbc8460ee9525a75672ba9ec5`

See [the dated provider/dependency review and limitations](docs/27-release-readiness.md).
