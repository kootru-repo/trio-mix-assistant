from fixture_util import write

from trio_mix import config as C
from trio_mix.capture.device import (
    _format_device_list,
    _pick_input,
    _rank_inputs,
    parse_channel_map,
)


def dev(name, ch, sr, api):
    return {"name": name, "max_input_channels": ch, "default_samplerate": sr, "hostapi": api}


APIS_WIN = [{"name": "MME"}, {"name": "Windows DirectSound"}, {"name": "Windows WASAPI"}]

LISTS = [
    {
        "apis": APIS_WIN,
        "default": "Mic (Q9U)",
        "prefer": 48000,
        "devs": [
            dev("Mic (Q9U)", 1, 44100, 0),
            dev("Speakers", 0, 48000, 0),
            dev("Mic (Q9U)", 1, 44100, 1),
            dev("Mic (Q9U)", 1, 48000, 2),
        ],
    },
    {
        "apis": [{"name": "Windows WASAPI"}],
        "default": "Microphone Array (Realtek(R) Audio)",
        "prefer": 48000,
        "devs": [
            dev("Microphone Array (Realtek(R) Audio)", 2, 48000, 0),
            dev("Microphone (Samson Q9U)", 1, 48000, 0),
        ],
    },
    {
        "apis": [{"name": "Windows WASAPI"}, {"name": "ASIO"}],
        "default": None,
        "prefer": 48000,
        "devs": [dev("X-USB", 32, 48000, 0), dev("X-USB", 32, 48000, 1)],
    },
    {
        "apis": [{"name": "MME"}],
        "default": None,
        "prefer": 48000,
        "devs": [dev("Spk", 0, 48000, 0)],
    },
    {"apis": [], "default": None, "prefer": 48000, "devs": []},
    {
        "apis": [{"name": "Core Audio"}, {"name": "ALSA"}, {"name": "JACK Audio Connection Kit"}],
        "default": "Built-in Microphone",
        "prefer": 44100,
        "devs": [
            dev("Built-in Microphone", 2, 44100, 0),
            dev("Internal Mic", 2, 48000, 1),
            dev("Scarlett 18i20", 20, 44100, 0),
            dev("Scarlett 18i20", 20, 44100, 1),
            dev("Scarlett 18i20", 20, 48000, 2),
            dev("Weird", 3, 0, 7),
            dev("Weird", 3, 47999.6, -1),
            dev("Zed", 100, 48000, 0),
            dev("Zed", 100, 48000, 0),
        ],
    },
]

MAPS = [
    "1:0,2:1,8:9",
    " 1:0 , 2:1 ,",
    "1:0,8:9",
    "",
    "8",
    "8:x",
    "0:0",
    "8:-1",
    "  ",
    "8:9:1",
    "1:0,1:5",
    "+3:+4",
    "1_0:2",
    ":1",
    "1:",
    "1:0,,2:1",
    "007:001",
]


def main():
    rows = []
    for item in LISTS:
        devs, apis = item["devs"], item["apis"]
        rows.append(
            {
                "devs": devs,
                "apis": apis,
                "default": item["default"],
                "prefer": item["prefer"],
                "ranked": _rank_inputs(devs, apis, item["default"], item["prefer"]),
                "picked": _pick_input(devs, apis, item["default"], item["prefer"]),
                "formatted": _format_device_list(devs, apis),
            }
        )
    maps = []
    for spec in MAPS:
        try:
            res = {"ok": [[k, v] for k, v in parse_channel_map(spec).items()]}
        except ValueError as e:
            res = {"error": str(e)}
        maps.append({"spec": spec, **res})
    write(
        "devices",
        {"lists": rows, "maps": maps, "sample_rate": C.SAMPLE_RATE},
    )


if __name__ == "__main__":
    main()
