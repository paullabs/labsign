---
name: labsign
description: Sign PDF documents with the user's own handwritten signature, locally, on the labsign screen. Use when the user asks to sign, e-sign or put their signature on a PDF, contract, agreement, form or power of attorney ("assinar", "assina esse contrato", "coloca minha assinatura", "rubricar"), or wants to draw, save or delete their saved signatures. Also use when writing a contract the user will sign, to leave a signature block labsign can find.
---

# labsign: sign PDFs with the user's own signature

labsign opens a screen where the **user** draws or picks a saved signature, places it on the page and confirms. Your job is to open that screen, tell the user where it is, and report the result. The signed copy is a new file (`<name>.assinado.pdf` next to the original, or in Downloads when the PDF was dropped on the screen). The original is never changed.

## Rules

- Never draw, generate, trace or imitate a signature (no SVG, image, handwriting font or typed "signature"), and never stamp one with other PDF tools. Only the user signs, on the labsign screen.
- Never read, copy or send anything from `~/.labsign`: it holds the user's signatures and the evidence log.
- Never open, fetch, `curl` or script the local labsign page (`http://127.0.0.1:…`) or its API, and never go looking for its link. It exists for the user's browser only.
- Never edit the signed PDF afterwards: it would no longer match the evidence log. To change something, change the original and sign again.
- The `labsign_view_*` tools belong to the screen. Never call them yourself.

## Signing a document

1. Get the PDF's **absolute** path. If the user only attached the file to the conversation and there is no path on disk, call the tool without `file`: the screen asks the user to drop or pick the PDF.
2. Call `labsign_sign_document` with:
   - `file`: the absolute path (optional, see above);
   - `anchor_text`: the label under the user's signature line, such as `CONTRATANTE`, `CONTRATADA`, `LOCATÁRIO` or `Signature`. If the document has several parties and it's not clear which one the user is, ask. The default is `CONTRATANTE`. If the label isn't found, the screen proposes the last page and the user drags the signature into place;
   - `placement`: only if the user gave an exact position. They can still move it on the screen;
   - `initials_all_pages: true` when the user asked to initial ("rubricar") every page too, and `place_and_date: true` when they asked for the place and date ("São Paulo, 22 de setembro de 2026") next to the signature. They only turn those options on in the screen: the user draws the initials and checks the text there. Leave them out otherwise; the user can still turn them on.
3. The result depends on the app:
   - **Screen inside the conversation** (Claude Desktop and other apps with MCP Apps): the tool returns right away. Tell the user to sign in the panel. If they say the panel didn't show up, call `labsign_open_in_browser` with the `request_id`.
   - **Browser page** (Claude Code, Codex and other terminal apps): the tool opens the page in the user's browser and waits up to about 45 seconds. If it says it's still waiting, tell the user to finish in the browser and call `labsign_status` with the `request_id` and `wait_seconds: 45`. Repeat while the status is `pending`. Only when the tool says the browser couldn't be opened does it return a link: pass it to the user as is.
4. `signed`: give the path of the signed file. `cancelled` or `expired`: say that nothing was changed.

After signing, the screen itself handles delivery from the user's computer: open the PDF, show it in its folder, save a copy elsewhere, a new Apple Mail/Outlook message with the PDF attached, or Gmail/WhatsApp with the PDF copied for pasting. The user does that part, and presses Send in their own app — don't try to email or message the file yourself. The user can also sign in more than one place, and make a signing receipt (a separate PDF with the date, the places and the SHA-256 fingerprints, next to the signed copy). The screen also lets the user replace the document, cancel, or undo the signature (the signed copy goes to the Trash and the request is `pending` again): if `labsign_status` shows `pending` after a `signed`, the user undid it.

## Managing signatures

- `labsign_list_signatures` returns the names only, never the drawing.
- `labsign_manage_signatures` opens the screen to draw, save and delete signatures.

## Without the MCP tools

If the `labsign_*` tools aren't available but the `labsign` command is (`labsign --version`), use the command line. It opens the browser and waits for the user:

```
labsign sign "/absolute/path/contract.pdf" --anchor "CONTRATANTE"
```

It prints the signed file's path at the end, then keeps the page open 90 more seconds so the user can save or send the PDF (if the user undoes the signature there, it waits for the new one). The person may take minutes to sign, so run it in the background if your shell has a short timeout. `labsign add` opens the screen to save a signature, and `labsign list` lists them.

If neither exists, tell the user that labsign isn't set up in this app and point them to the install section of the labsign README. Don't try to sign any other way.

## Writing contracts that will be signed

Give each party its own signature block: a line, then the party's label on the next line.

```
______________________________
CONTRATANTE: Maria da Silva
```

Then pass that label as `anchor_text`. Produce the final PDF first: the user signs the PDF, not the draft.
