# Changelog

## [0.1.5](https://github.com/joaodrp/omarchy-auto-brightness/compare/v0.1.4...v0.1.5) (2026-11-04)


### Features

* **control:** add the control pipeline as pure JS, with a curve in nits ([627e11d](https://github.com/joaodrp/omarchy-auto-brightness/commit/627e11d2c3b248c5b2b389a3fb461759a08f9305))
* **control:** bend the curve for a preference, as Android does ([491dc5a](https://github.com/joaodrp/omarchy-auto-brightness/commit/491dc5a170ff46a3e61f68eb29620b320126d0a5))
* drive every connected display independently ([9c36cf9](https://github.com/joaodrp/omarchy-auto-brightness/commit/9c36cf9681c231282ad8d0b3a32e1d5fa662c99b))
* **endpoint:** schedule each display's writes and read-backs ([d9b0277](https://github.com/joaodrp/omarchy-auto-brightness/commit/d9b02777c9409e1b30a0c74584a6b93699f0440d))
* **inventory:** describe displays, sensors and their pairing ([acbadca](https://github.com/joaodrp/omarchy-auto-brightness/commit/acbadca7f98e3de8a1264e9ea00621fb8bfe4592))
* **panel:** show and control the display each bar is on ([e504046](https://github.com/joaodrp/omarchy-auto-brightness/commit/e504046b8558f76a1732e2824089d371db2b616b))


### Bug Fixes

* **control:** hold a choice while the light stays near, as Android does ([59e5fbf](https://github.com/joaodrp/omarchy-auto-brightness/commit/59e5fbfbae5cc24f3fcef3c70d9992624ea44b06))
* **service:** do not report a sensor as failed after a suspend ([c06f409](https://github.com/joaodrp/omarchy-auto-brightness/commit/c06f4097decd711d31de39d5931c2e8b5e271341))
* **settings:** keep a learned offset across an unrelated Setup edit ([#12](https://github.com/joaodrp/omarchy-auto-brightness/issues/12)) ([1185179](https://github.com/joaodrp/omarchy-auto-brightness/commit/11851797695a0c8a86bd8faf47ea2c5e696087a0))

## [0.1.4](https://github.com/joaodrp/omarchy-auto-brightness/compare/v0.1.3...v0.1.4) (2026-11-02)


### Features

* drive the laptop panel when no Studio Display is connected ([1459c83](https://github.com/joaodrp/omarchy-auto-brightness/commit/1459c830a2a80c8188d4021acf6d647229bd16ac))
* fade smoothly on displays with fine brightness levels ([48c69ca](https://github.com/joaodrp/omarchy-auto-brightness/commit/48c69ca8bc30027a38d91f1bedecdb1f1802d4fd))


### Bug Fixes

* re-attach a display whose device stops reading ([190c257](https://github.com/joaodrp/omarchy-auto-brightness/commit/190c2578d1c60ea0e9aa1a0002aa17d4c23bf32f))
* stop settings echoes from bouncing brightness ([2062fb3](https://github.com/joaodrp/omarchy-auto-brightness/commit/2062fb3b4b0bc6d25014085ff123b1043e1d3294))

## [0.1.3](https://github.com/joaodrp/omarchy-auto-brightness/compare/v0.1.2...v0.1.3) (2026-09-20)


### Miscellaneous Chores

* release 0.1.3 ([#8](https://github.com/joaodrp/omarchy-auto-brightness/issues/8)) ([e5c3305](https://github.com/joaodrp/omarchy-auto-brightness/commit/e5c3305151d97d107b104bbcc9ef85687e1200f5))

## [0.1.2](https://github.com/joaodrp/omarchy-auto-brightness/compare/v0.1.1...v0.1.2) (2026-09-19)


### Bug Fixes

* restore the widget under omarchy 4.0.4 ([#5](https://github.com/joaodrp/omarchy-auto-brightness/issues/5)) ([cd34ce1](https://github.com/joaodrp/omarchy-auto-brightness/commit/cd34ce1fcf910915acd3c09e2e7c9c5536292767))

## [0.1.1](https://github.com/joaodrp/omarchy-auto-brightness/compare/v0.1.0...v0.1.1) (2026-09-13)


### Features

* a manual change lands in one write ([d74dd32](https://github.com/joaodrp/omarchy-auto-brightness/commit/d74dd3200262c11a66f3cb5d0e2ab9e97ec17625))
* derive the ramp step from the measured write latency ([f176a59](https://github.com/joaodrp/omarchy-auto-brightness/commit/f176a59c4ffb812a45ed61574c6e5e023ecd28dc))
* write each ramp move as one- and two-point steps ([5f65317](https://github.com/joaodrp/omarchy-auto-brightness/commit/5f653172a31541e732796c4e7f0e3b6b0b25293d))


### Bug Fixes

* drain stdin without spinning, adopt the display when Auto turns on, write past the helper's lock ([c86bec8](https://github.com/joaodrp/omarchy-auto-brightness/commit/c86bec8ced8346121a5d8c8950b7ab88ef7cfa31))
* honour the ramp cap, never overwrite a hotkey, and nine more review findings ([7547316](https://github.com/joaodrp/omarchy-auto-brightness/commit/75473168168db20f8a0b4e276fc738f94f494689))

## 0.1.0 (2026-09-12)


### Features

* a manual change sets the offset, kept until cleared ([f424548](https://github.com/joaodrp/omarchy-auto-brightness/commit/f424548f2fac5c7539247e3c7375121cc849d82d))
* auto brightness as a labelled toggle row under the slider ([086a888](https://github.com/joaodrp/omarchy-auto-brightness/commit/086a8884b577c554a209da41bdea803aeb52c97d))
* auto brightness as a mode chip beside the section header ([8bdd98a](https://github.com/joaodrp/omarchy-auto-brightness/commit/8bdd98a3325dba7218cd54d687fbf1d073790f3c))
* auto brightness switch for the Apple Studio Display ([f2aaaf3](https://github.com/joaodrp/omarchy-auto-brightness/commit/f2aaaf3cbf63b4c9f5b7e1dc78c2960c3e5bf731))
* call the widget Brightness ([bd0cdec](https://github.com/joaodrp/omarchy-auto-brightness/commit/bd0cdec4761507d6df583be74df259ce999cada5))
* hero owns the title, mode chip and lux; the slider is the content ([c9eece0](https://github.com/joaodrp/omarchy-auto-brightness/commit/c9eece08a30eb9b5cd98f36451293ff3a323a41e))
* label the auto switch ([e066b5a](https://github.com/joaodrp/omarchy-auto-brightness/commit/e066b5a99cfb29a33d08b1ca65df757b1e36e1cb))
* learn manual changes, add hysteresis and debounce, re-anchor the curve ([86d6ee6](https://github.com/joaodrp/omarchy-auto-brightness/commit/86d6ee6ababe7aed7d3a6d27644c172fa3512f67))
* put the auto switch beside the section header ([8fdb013](https://github.com/joaodrp/omarchy-auto-brightness/commit/8fdb013fb4863754420901cc944309149647cd5f))
* ramp at a fixed rate with a duration cap ([f7dc2c4](https://github.com/joaodrp/omarchy-auto-brightness/commit/f7dc2c44423e283724c400dd4c0f9a19c55f6b7a))
* restore button while a correction is learned ([9728eaa](https://github.com/joaodrp/omarchy-auto-brightness/commit/9728eaafef23dc2693a6d0602617936765941def))
* standalone bar widget instead of a Display panel clone ([2a900a5](https://github.com/joaodrp/omarchy-auto-brightness/commit/2a900a59280c73ea488ad2882aa95c8561e6660c))


### Bug Fixes

* align the auto label with the header and show the learned offset there ([4c38882](https://github.com/joaodrp/omarchy-auto-brightness/commit/4c38882c902248c860c0b9ec0d40ce91b04a221e))
* declare the panel's IPC target ([1fd7b9e](https://github.com/joaodrp/omarchy-auto-brightness/commit/1fd7b9e08e0d8bbaf5da2b6e3c7740e61b4416d3))
