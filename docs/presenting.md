# Prototypes, presenting and slides

Frames can link to each other, play as a walkable prototype and, when marked as slides, play as a deck with speaker notes.
Presenting needs only the view role, so a stakeholder with a review link can walk a flow too.

## Prototype links

Put `data-goto` on any element in a frame, set to the id or the name of another frame on the same canvas:

```html
<a data-goto="Pricing">See pricing</a>
```

A frame name matches case-insensitively and exactly; the first frame in reading order wins.
Agents are told to use ids, which `create_frame` returns.

On the canvas a click still selects the element, so links stay inert.
Hold <kbd>Alt</kbd> and click to follow a link, or press <kbd>K</kbd> to draw an arrow for every link.

## Present mode

Press <kbd>⇧P</kbd>, or the play button, to present from the selected frame, or from the first frame of the page when nothing is selected.

| Key                         | Action                                   |
| --------------------------- | ---------------------------------------- |
| <kbd>→</kbd> / <kbd>←</kbd> | Next and previous frame in reading order |
| A link                      | Jump to the frame it points to           |
| <kbd>Backspace</kbd>        | Go back to the previous screen           |
| <kbd>Esc</kbd>              | Exit                                     |

Reading order bands the frames of a page into rows from top to bottom, and left to right within a row.
Frames that share a `view-transition-name` morph between screens; without view-transition support the swap is a short crossfade.
Each frame is scaled to fit the screen at its own size.

## Slides

Mark frames as slides with the Inspector's **Slide** checkbox, "Make a slide" in the frame menu, or `slide: true` on `create_frame` and `update_frame`.
A slide defaults to 1280 by 720.
When the presented frame is a slide, the slides of its page play as a deck in reading order: <kbd>Space</kbd>, a click and <kbd>→</kbd> advance.

While a deck plays, the runtime sets `data-sl-play` on the document, and `data-sl-entered` once a slide has arrived.
Key entrance animations off them, for example `[data-sl-entered] .title { animation: rise 400ms both }`, and they run each time a slide arrives.

## Speaker notes and the presenter view

Write speaker notes in the Inspector, or pass `speaker_notes` (markdown) to `create_frame` and `update_frame`.
Notes never appear on the slide.

Press <kbd>S</kbd> during a show to open the presenter view: the slide's notes, the next slide, a timer and the slide number.
The toolbar button opens it in a window of its own, so you can present on one screen and read notes on another.

## Deck PDF

Choose **Export deck as PDF** in the present toolbar, or right-click a page.
It renders one PDF page per slide at the slide's own size, with each slide in the state a viewer sees once it has arrived.
Signed-out guests are not offered the PDF, and each account is limited to a few exports a minute.
