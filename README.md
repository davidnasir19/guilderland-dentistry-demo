# Guilderland — website design concept

**[Open the live demonstration](https://davidnasir19.github.io/guilderland-dentistry-demo/)**

A responsive, immersive website concept for a dental practice, designed as a portfolio showcase for business presentations.

- Scroll-driven tour with dedicated desktop and mobile imagery.
- Editorial typography, services, practice presentation and before/after comparison.
- Ambient films, accessible navigation, reduced-motion and still-image modes.
- Plain HTML, CSS and JavaScript; no framework or application server.

This is an independent portfolio demonstration, not the practice's official website or an endorsed project. The AI-generated tour and illustrative imagery are identified on the page. The demonstration does not collect appointment requests. Practice phone and external links are included as part of the concept.

## Publish and update

GitHub Pages publishes automatically from `main` using `.github/workflows/deploy.yml`.
Edit `index.html`, `assets/css/site.css`, `assets/js/` or `content/flight.json`, then commit the changes.

The supplied media are stored in ZIP bundles to keep the browser upload manageable. The build verifies their SHA-256 checksums and extracts them into the published website. Browsers load ordinary image and video files, never the ZIP bundles.

## Preview locally

```sh
python3 scripts/build.py
python3 -m http.server 8000 --directory _site
```

Visit http://localhost:8000/. Desktop and mobile tour media are checked during the build.

Business names, logos, photographs and supplied media remain the property of their respective owners. Their inclusion here does not grant reuse rights for other clients.

## Scroll performance

The tour uses a fully buffered H.264 film with a keyframe every four frames. Its camera follows native scrolling with a short 65 ms easing window. Only the newest requested seek is kept, and only one seek runs at a time. Desktop media retain the 1280×720 source resolution and mobile media use a 720×720 crop, encoded at CRF 23; scrolling makes no per-frame network requests. The legacy WebP sequences remain archived for reference. Reduced-motion and network-failure fallbacks use the still-image layout.
