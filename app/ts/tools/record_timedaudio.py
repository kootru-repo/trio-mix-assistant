from fixture_util import f32, write

from trio_mix import config as C
from trio_mix.emulator import TimedAudioStream


def main():
    out = []
    for channels in (8, 4, 12):
        ts = TimedAudioStream(callback=lambda *a: None, channels=channels)
        frames = [ts._default_content(i) for i in (0, 1, 7, 59, 60, 123)]
        out.append(
            {
                "channels": channels,
                "indexes": [0, 1, 7, 59, 60, 123],
                "frames": [f32(f.reshape(-1)) for f in frames],
                "block": C.BLOCK,
            }
        )
    write("timedaudio", out)


if __name__ == "__main__":
    main()
