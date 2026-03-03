{
  "targets": [
    {
      "target_name": "pxlib",
      "sources": [
        "src/addon.cc",
        "../../src/gregor.c",
        "../../src/paradox.c",
        "../../src/px_crypt.c",
        "../../src/px_encode.c",
        "../../src/px_error.c",
        "../../src/px_head.c",
        "../../src/px_io.c",
        "../../src/px_memory.c",
        "../../src/px_memprof.c",
        "../../src/px_misc.c"
      ],
      "include_dirs": [
        "include",
        "../../src",
        "../../include"
      ],
      "defines": [
        "HAVE_CONFIG_H",
        "_CRT_SECURE_NO_DEPRECATE"
      ],
      "cflags_c": [
        "-std=c99"
      ],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "defines": [
              "WIN32"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": [
                  "/std:c++17"
                ]
              }
            }
          }
        ],
        [
          "OS!=\"win\"",
          {
            "cflags_cc": [
              "-std=c++17"
            ]
          }
        ]
      ]
    }
  ]
}
