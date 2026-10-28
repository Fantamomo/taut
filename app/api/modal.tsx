import { within } from '../helpers'
import { reactPromise } from '../slack/react'
import { getReduxStore } from '../slack/redux'
import { byMeta, waitForExport } from '../slack/webpack'
import { elementsAPIPromise, type FormTextInputProps } from './elements'

/** how long a modal waits for Slack's modal system to load before it counts as dismissed */
const MODAL_WAIT_MS = 10_000
/** input types where Enter submits the modal */
const TEXT_INPUTS = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
])

type RawModalHandle = { close: () => void; render: (props: unknown) => void }
type OpenModalThunk = (opts: {
  element: React.ReactElement
  name?: string
  isStackable?: boolean
}) => unknown

export interface OpenModalOptions {
  title: React.ReactNode
  body: React.ReactNode
  submitText?: string
  cancelText?: string
  danger?: boolean
  showCancelButton?: boolean
  showSubmitButton?: boolean
  onSubmit?: () => void
  onCancel?: () => void
  onClose?: () => void
}

export interface ModalHandle {
  close: () => void
}

export interface ConfirmOptions {
  title: React.ReactNode
  body?: React.ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export interface AlertOptions {
  title: React.ReactNode
  body?: React.ReactNode
  closeText?: string
}

export function dialogHelpersFor(
  openModal: (options: OpenModalOptions) => ModalHandle | null
) {
  /** resolves `true` if confirmed, `false` on cancel or dismissal */
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (result: boolean) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const handle = openModal({
        title: options.title,
        body: options.body ?? null,
        submitText: options.confirmText ?? 'Confirm',
        cancelText: options.cancelText ?? 'Cancel',
        danger: options.danger,
        onSubmit: () => settle(true),
        onCancel: () => settle(false),
        onClose: () => settle(false),
      })
      if (!handle) settle(false)
    })
  }

  /** a dialog with one close button, resolves once the user dismisses it */
  function alert(options: AlertOptions): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const handle = openModal({
        title: options.title,
        body: options.body ?? null,
        submitText: options.closeText ?? 'OK',
        showCancelButton: false,
        onSubmit: settle,
        onClose: settle,
      })
      if (!handle) settle()
    })
  }

  return { confirm, alert }
}

export const modalAPIPromise = (async () => {
  await reactPromise
  const elements = await elementsAPIPromise

  const openModalThunk = waitForExport<OpenModalThunk>(byMeta('openModal'))

  const Confirmation = elements.ConfirmationModal
  const Label = elements.Label

  function TextInput({ autoFocus, inputRef, ...props }: FormTextInputProps) {
    const input = React.useRef<HTMLInputElement | null>(null)
    // the submit button focuses itself as it mounts, effects run after that
    // (slack's button likes to autofocus, which we want to override)
    React.useEffect(() => {
      if (autoFocus) input.current?.focus()
    }, [])
    return (
      <elements.FormTextInput
        {...props}
        inputRef={(node) => {
          input.current = node
          if (typeof inputRef === 'function') inputRef(node)
          else if (inputRef) inputRef.current = node
        }}
      />
    )
  }

  function openModal(options: OpenModalOptions): ModalHandle {
    let raw: RawModalHandle | undefined
    let closed = false
    const close = () => {
      closed = true
      raw?.close()
    }
    const submit = () => {
      options.onSubmit?.()
      close()
    }
    const element = (
      <Confirmation
        title={options.title}
        submitButtonText={options.submitText ?? 'Save'}
        cancelButtonText={options.cancelText ?? 'Cancel'}
        submitButtonType={options.danger ? 'danger' : 'primary'}
        showCancelButton={options.showCancelButton ?? true}
        showSubmitButton={options.showSubmitButton ?? true}
        onSubmit={submit}
        onCancel={() => {
          options.onCancel?.()
          close()
        }}
        onClose={() => {
          options.onClose?.()
          close()
        }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: delegates Enter from the fields inside */}
        <div
          onKeyDown={(event) => {
            const field = event.target as HTMLInputElement
            if (
              event.key === 'Enter' &&
              !event.defaultPrevented &&
              !event.nativeEvent.isComposing &&
              !(
                event.shiftKey ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey
              ) &&
              field.tagName === 'INPUT' &&
              TEXT_INPUTS.has(field.type) &&
              // react bubbles events from portals (like a picker) here too
              event.currentTarget.contains(field) &&
              (options.showSubmitButton ?? true)
            ) {
              event.preventDefault()
              submit()
            }
          }}
        >
          {options.body}
        </div>
      </Confirmation>
    )

    const name = typeof options.title === 'string' ? options.title : 'modal'
    within(openModalThunk, MODAL_WAIT_MS, "Slack's openModal action").then(
      (openModalAction) => {
        if (closed) return
        const store = getReduxStore()
        if (!openModalAction || !store) return options.onClose?.()
        raw = store.dispatch(
          openModalAction({ element, name, isStackable: true })
        ) as RawModalHandle | undefined
      }
    )
    return { close }
  }

  return { openModal, ...dialogHelpersFor(openModal), Label, TextInput }
})()

export type ModalAPI = Awaited<typeof modalAPIPromise>
