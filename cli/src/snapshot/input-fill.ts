import { Predicate } from "effect"
import type { ElementHandle, Page } from "patchright-core"
import type { InputField, InputTarget } from "./types.ts"

export async function fillInput(options: { readonly page: Page; readonly target: InputTarget; readonly value: string }): Promise<void> {
  if (Predicate.isString(options.target)) {
    await fillInputs(options.page, [{ selector: options.target, value: options.value }])
    return
  }
  const locator = options.target
  await locator.evaluate((element, nextValue) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
      const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, nextValue)
      } else {
        element.value = nextValue
      }
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = nextValue
    } else {
      throw new Error("fillInput expects an input, textarea, or contenteditable locator")
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  }, options.value, { timeout: 30_000 })
}

export async function fillInputs(page: Page, fields: ReadonlyArray<InputField>): Promise<void> {
  const locatorHandles: ElementHandle[] = []
  try {
    const resolvedFields: Array<{ readonly target: string | ElementHandle; readonly label: string; readonly value: string }> = []
    for (const field of fields) {
      if (Predicate.isString(field.selector)) {
        resolvedFields.push({ target: field.selector, label: `selector: ${field.selector}`, value: field.value })
        continue
      }
      const matches = await field.selector.elementHandles()
      locatorHandles.push(...matches)
      if (matches.length !== 1) {
        throw new Error(`fillInputs expects exactly one match for locator; got ${matches.length}`)
      }
      resolvedFields.push({ target: matches[0]!, label: "locator", value: field.value })
    }

    await page.evaluate((inputFields) => {
      return inputFields.map((field) => {
        let element: Node | undefined
        if (typeof field.target === "string") {
          const matches: Element[] = []
          const roots: Array<Document | ShadowRoot> = [document]
          for (let index = 0; index < roots.length; index += 1) {
            const root = roots[index]
            if (!root) continue
            matches.push(...root.querySelectorAll(field.target))
            for (const candidate of root.querySelectorAll("*")) {
              if (candidate.shadowRoot) roots.push(candidate.shadowRoot)
            }
          }
          if (matches.length !== 1) {
            if (matches.length === 0) {
              throw new Error(`fillInputs found no match for ${field.label} in the document or open shadow roots; closed shadow roots are unavailable. Try locator.fill() if Playwright can resolve the field.`)
            }
            throw new Error(`fillInputs expects exactly one match for ${field.label}; got ${matches.length}`)
          }
          element = matches[0]
        } else {
          element = field.target
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
          const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
          const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
          if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, field.value)
          } else {
            element.value = field.value
          }
        } else if (element instanceof HTMLElement && element.isContentEditable) {
          element.textContent = field.value
        } else {
          throw new Error(`fillInputs expects input, textarea, or contenteditable ${field.label}`)
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: field.value }))
        element.dispatchEvent(new Event("change", { bubbles: true }))
        return field.label
      })
    }, resolvedFields)
  } finally {
    await Promise.all(locatorHandles.map((handle) => handle.dispose().catch(() => {})))
  }
}
