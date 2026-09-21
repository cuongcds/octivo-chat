# Octivo Chat

Embeddable chat widget for Octivo CRM `website` channels (`website_theme = 'customize'`). Self-contained — injects its own CSS and DOM into the host page, so it can be dropped into any third-party site with a single `<script>` tag.

Supports image attachments (JPG/PNG/GIF/WEBP, up to 8MB) and an emoji picker.

## Install via jsDelivr

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/octivo-chat@0.1.0/dist/octivo-chat.min.css">
<script src="https://cdn.jsdelivr.net/npm/octivo-chat@0.1.0/dist/octivo-chat.min.js" data-channel="your-channel-slug" async></script>
```

Replace `your-channel-slug` with your channel source id.

By default, the widget talks to `https://octivo.shplinks.com`. To point it at a different Octivo instance, add `data-host="https://your-instance.example.com"` to the `<script>` tag, or pass `host` to `init()`.

## Usage

```html
<script src="https://cdn.jsdelivr.net/npm/octivo-chat@0.1.0/dist/octivo-chat.min.js" data-channel="your-channel-slug" async></script>
<script>
  // optional, any time after the script tag:
  window.OctivoChat.init({
    name: 'Jane', phone: '0901234567', autoOpen: true,
    showBubble: false,        // hide the floating button; open() from your own UI instead
    onClose: function () {},  // fired whenever the popup is closed
  });
  document.querySelector('#my-chat-button').addEventListener('click', OctivoChat.open);
  window.addEventListener('octivochat:close', function (e) { /* ... */ });
</script>
```

## Development

Source lives in `src/`. Build minified output with:

```bash
npx terser src/octivo-chat.js -c -m -o dist/octivo-chat.min.js
npx clean-css-cli -o dist/octivo-chat.min.css src/octivo-chat.css
```
