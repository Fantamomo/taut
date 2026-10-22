// Uploads an audio file as your name recording, instead of recording one

import { TautPlugin } from '$taut'

type AudioButtonProps = {
  onChangeFile?: (fileId: string | null) => void
  onFileUploadStart?: () => void
  onFileUploadEnd?: () => void
}

/** the audio file they chose, or null if they closed the picker */
function pickAudio(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    Object.assign(input, { type: 'file', accept: 'audio/*' })
    input.style.display = 'none'
    const done = (file: File | null) => {
      resolve(file)
      input.remove()
    }
    input.addEventListener('change', () => done(input.files?.[0] ?? null), {
      once: true,
    })
    input.addEventListener('cancel', () => done(null), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

/** whether the bytes start with an ID3 tag or an MPEG audio frame header */
function isMp3(bytes: ArrayBuffer): boolean {
  const [a = 0, b = 0, c = 0] = new Uint8Array(bytes.slice(0, 3))
  if (a === 0x49 && b === 0x44 && c === 0x33) return true
  return a === 0xff && (b & 0xe0) === 0xe0 && (b & 0x06) !== 0
}

/** plays the audio into a MediaRecorder */
async function rerecord(audio: AudioBuffer): Promise<Blob> {
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t)
  )
  if (!type) throw new Error('This browser cannot convert audio')
  const context = new AudioContext({ sampleRate: audio.sampleRate })
  try {
    await context.resume()
    const source = context.createBufferSource()
    source.buffer = audio
    const destination = context.createMediaStreamDestination()
    source.connect(destination)
    const recorder = new MediaRecorder(destination.stream, {
      mimeType: type,
      audioBitsPerSecond: 128_000,
    })
    const chunks: Blob[] = []
    recorder.addEventListener('dataavailable', (e) => chunks.push(e.data))
    const stopped = new Promise((resolve) =>
      recorder.addEventListener('stop', resolve, { once: true })
    )
    source.addEventListener('ended', () => recorder.stop(), { once: true })
    // the recorder drops about the first 100ms played before it's running
    recorder.addEventListener(
      'start',
      () => source.start(context.currentTime + 0.05),
      { once: true }
    )
    recorder.start()
    await stopped
    return new Blob(chunks, { type })
  } finally {
    context.close()
  }
}

/** the waveform Slack draws, one peak per bar, each 0-100 */
function peaks(channel: Float32Array, count: number): number[] {
  const width = Math.max(1, Math.floor(channel.length / count))
  return Array.from({ length: count }, (_, bar) => {
    const start = bar * width
    const end = Math.min(channel.length, start + width)
    let peak = 0
    for (let i = start; i < end; i++)
      peak = Math.max(peak, Math.abs(channel[i] ?? 0))
    return Math.round(peak * 100)
  })
}

export default class CustomNameRecording extends TautPlugin<
  typeof CustomNameRecording
> {
  static readonly id = 'CustomNameRecording'
  static readonly pluginName = 'Custom Name Recording'
  static readonly description =
    'Uploads an audio file as your name recording, instead of recording one'
  static readonly authors = ['jeremy'] as const
  static readonly category = 'people'
  static readonly defaultConfig = {
    enabled: true,
  }

  start(): void {
    this.api.patchComponent<AudioButtonProps>(
      'EditAudioButton',
      (Original) => (props) => (
        <>
          <Original {...props} />
          <this.UploadButton {...props} />
        </>
      )
    )

    this.api.setStyle(`
      .taut-name-recording__upload { margin-left: 8px; }
      .taut-name-recording__error { margin-top: 4px; }
    `)

    this.log('Started')
  }

  private UploadButton = (props: AudioButtonProps) => {
    const { Button, SvgIcon, InlineAlert } = this.api.elements
    const [busy, setBusy] = React.useState<string | null>(null)
    const [error, setError] = React.useState<string | null>(null)

    const onClick = () => {
      setError(null)
      this.upload(props, setBusy)
        .catch((err) => setError(err?.message || 'Could not upload that file'))
        .finally(() => setBusy(null))
    }

    return (
      <>
        <Button
          className="taut-name-recording__upload"
          type="outline"
          size="medium"
          onClick={onClick}
          disabled={busy !== null}
        >
          <SvgIcon name="file-upload" size={18} inline />
          <span className="margin_left_25">{busy ?? 'Upload audio'}</span>
        </Button>
        {error ? (
          <InlineAlert className="taut-name-recording__error c-inline_alert--level_error">
            {error}
          </InlineAlert>
        ) : null}
      </>
    )
  }

  private async upload(
    props: AudioButtonProps,
    setBusy: (label: string | null) => void
  ) {
    const source = await pickAudio()
    if (!source) return

    setBusy('Checking...')
    const file = await this.describe(source, () => setBusy('Converting...'))

    setBusy('Uploading...')
    props.onFileUploadStart?.()
    try {
      props.onChangeFile?.(await this.api.files.upload(file))
    } finally {
      props.onFileUploadEnd?.()
    }
  }

  // Slack reads these off the file rather than measuring it
  private async describe(source: File, onConvert: () => void) {
    const bytes = await source.arrayBuffer()
    const mp3 = isMp3(bytes)
    const context = new AudioContext()
    let audio: AudioBuffer
    try {
      audio = await context.decodeAudioData(bytes)
    } catch {
      throw new Error('That file could not be read as audio')
    } finally {
      context.close()
    }
    let file: File
    if (mp3) {
      file = new File([source], 'audio_name_pronunciation.mp3', {
        type: 'audio/mpeg',
      })
    } else {
      onConvert()
      const blob = await rerecord(audio)
      file = new File([blob], 'audio_name_pronunciation.m4a', {
        type: blob.type,
      })
    }
    const bars = Math.min(100, Math.max(20, Math.round(audio.duration * 5)))
    return Object.assign(file, {
      subtype: 'slack_name_pronunciation',
      duration: audio.duration,
      audio_wave_samples: peaks(audio.getChannelData(0), bars),
    })
  }
}
