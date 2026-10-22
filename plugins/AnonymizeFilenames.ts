// Randomizes file names before uploading to prevent metadata leakage

import { TautPlugin } from '$taut'

function randomName(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint32Array(7)
  window.crypto.getRandomValues(bytes)
  let name = ''
  for (const byte of bytes) name += chars[byte % chars.length]
  return name
}

function fileExtension(name: string): string {
  const base = name.slice(
    Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1
  )
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

export default class AnonymizeFilenames extends TautPlugin<
  typeof AnonymizeFilenames
> {
  static readonly id = 'AnonymizeFilenames'
  static readonly pluginName = 'Anonymize Filenames'
  static readonly description =
    'Randomizes file names before uploading to prevent metadata leakage'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'messageBox'
  static readonly defaultConfig = {
    enabled: false,
  }

  /** each file to its renamed copy, and each copy to itself */
  private renamed = new WeakMap<File, File>()

  start(): void {
    this.api.redux.patchThunk(
      'addAndUploadPendingFile',
      (original) =>
        (args: { file?: unknown }, ...rest: unknown[]) =>
          original(
            args?.file ? { ...args, file: this.anonymize(args.file) } : args,
            ...rest
          )
    )
    this.api.redux.patchThunk(
      'uploadFiles',
      (original) =>
        (args: { files?: unknown }, ...rest: unknown[]) =>
          original(
            Array.isArray(args?.files)
              ? {
                  ...args,
                  files: args.files.map((file) => this.anonymize(file)),
                }
              : args,
            ...rest
          )
    )
  }

  private anonymize(file: unknown): unknown {
    // a file picked in a pop-out comes from that window's File, so instanceof misses it
    if (Object.prototype.toString.call(file) !== '[object File]') return file
    const original = file as File
    let copy = this.renamed.get(original)
    if (!copy) {
      // Slack reads properties it set on the file, like subtype and id
      copy = Object.assign(
        new File([original], randomName() + fileExtension(original.name), {
          type: original.type,
          lastModified: original.lastModified,
        }),
        original
      )
      this.renamed.set(original, copy)
      this.renamed.set(copy, copy)
    }
    return copy
  }
}
