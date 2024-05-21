# Image optimizer + cache with Tigris

This is a lightweight app that can optimize images and cache them on Tigris for even better performance. 

## Getting started

1. Deploy this as an app on your Fly.io organization
2. Set your Tigris credentials with `fly secrets set ...`

The end!

## Usage

Now that you have your image optimizer app deployed to Fly, you can request any images that exist in your Tigris bucket. When requesting images to optimize, this will be the base of your URL:

```
https://$YOUR_IMG_OPT_APP/$PATH_TO_FILE_IN_BUCKET
```

So for example, if you had a file inside your bucket at the path `blog/2024/hero.jpg`, then your base URL would be `https://$YOUR_IMG_OPT_APP/blog/2024/hero.jpg`

From there, you can include any of the following URL params to optimize your image:

- `width` (in pixels)
- `height` (in pixels)
- `quality` (1 - 100)
- `format` (e.g. `jpg`, `png`, etc)

This app uses package [sharp](https://sharp.pixelplumbing.com/) to perform the image transformations. For a full list of supported file extensions, check out their documentation.