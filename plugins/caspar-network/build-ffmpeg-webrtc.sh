#!/bin/bash
# Build script for FFmpeg with WebRTC/WHIP support
# Matches existing library support from snap version

set -e

BUILD_DIR="/tmp/ffmpeg"
INSTALL_PREFIX="/usr/local"

echo "=========================================="
echo "FFmpeg WebRTC Build Script"
echo "=========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "$BUILD_DIR/configure" ]; then
    echo "Error: FFmpeg source not found at $BUILD_DIR"
    echo "Please clone FFmpeg first:"
    echo "  cd /tmp && git clone https://git.ffmpeg.org/ffmpeg.git"
    exit 1
fi

cd "$BUILD_DIR"

echo "Step 1: Configuring FFmpeg with WebRTC support..."
echo "This will match existing library support from snap version"
echo ""
echo "⚠️  CRITICAL: SRT support is required for this project"
echo "   Verifying SRT development package..."
# Set PKG_CONFIG_PATH to find SRT pkg-config file
export PKG_CONFIG_PATH="${PKG_CONFIG_PATH}:/usr/lib/x86_64-linux-gnu/pkgconfig"
if ! pkg-config --exists srt; then
    # Try alternative name
    if ! pkg-config --exists libsrt; then
        echo "❌ ERROR: SRT development package is not properly installed!"
        echo "   Please install it with: sudo apt-get install -y libsrt-openssl-dev"
        echo "   (or libsrt-gnutls-dev if using GnuTLS)"
        exit 1
    fi
fi
echo "✅ SRT development package found"
echo ""

# Configure with libraries matching snap version
# Key addition: --enable-openssl for WHIP/DTLS support
# FFmpeg will auto-detect available libraries, but we explicitly enable common ones
CONFIGURE_OPTS=(
    --prefix="$INSTALL_PREFIX"
    --enable-gpl
    --enable-version3
    --enable-nonfree
    --enable-shared
    --disable-static
    --enable-openssl
    --disable-doc
    --disable-htmlpages
    --disable-manpages
    --disable-podpages
    --disable-txtpages
)

# Core codecs (commonly available)
# CRITICAL: SRT support is required for this project
CONFIGURE_OPTS+=(
    --enable-libx264
    --enable-libx265
    --enable-libvpx
    --enable-libfdk-aac
    --enable-libmp3lame
    --enable-libopus
    --enable-libvorbis
    --enable-libtheora
    --enable-libsrt
)

# Additional libraries (will be auto-detected if available)
# These match what the snap version has enabled
# NOTE: libsrt is already in core codecs above (required for this project)
# NOTE: libdav1d removed - system version (0.9.2) is too old, FFmpeg requires >= 1.0.0
ADDITIONAL_LIBS=(
    libaom libass libfreetype libfontconfig libfribidi
    libbluray libbs2b libcaca libcdio libcodec2 libdc1394 libdrm
    libflite libgme libgsm libopencore-amrnb libopencore-amrwb
    libopenjpeg libopenmpt libpulse librsvg librubberband libshine
    libsnappy libsoxr libspeex libssh libtesseract libtwolame
    libv4l2 libvo-amrwbenc libwebp libxcb libxml2 libxvid libzimg
    libzmq libzvbi
)

# Add libraries that are likely available (FFmpeg will skip if not found)
for lib in "${ADDITIONAL_LIBS[@]}"; do
    CONFIGURE_OPTS+=(--enable-$lib)
done

# Hardware acceleration and other features
CONFIGURE_OPTS+=(
    --enable-omx
    --enable-openal
    --enable-opencl
    --enable-opengl
    --enable-runtime-cpudetect
    --enable-sdl2
    --enable-vaapi
    --enable-vulkan
    --enable-xlib
    --enable-vdpau
    --enable-nvenc
    --enable-cuvid
)

echo "Running configure with options:"
echo "${CONFIGURE_OPTS[@]}"
echo ""
echo "Note: PKG_CONFIG_PATH is set to find SRT and other libraries"
echo ""

# Ensure PKG_CONFIG_PATH includes standard locations
export PKG_CONFIG_PATH="${PKG_CONFIG_PATH}:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/lib/pkgconfig:/usr/share/pkgconfig"

# Temporarily disable exit on error for configure (we'll handle failures)
set +e
./configure "${CONFIGURE_OPTS[@]}"
CONFIGURE_STATUS=$?
set -e

if [ $CONFIGURE_STATUS -ne 0 ]; then
    echo ""
    echo "Configuration failed! Some libraries may not be available."
    echo "The script will continue, but some features may be disabled."
    echo "Check the output above for missing dependencies."
    echo ""
    echo "Continuing anyway (non-interactive mode)..."
    # Try to continue with a more minimal configuration
    # Remove problematic --enable flags and let FFmpeg auto-detect
    echo "Attempting minimal configuration (auto-detecting available libraries)..."
    MINIMAL_OPTS=(
        --prefix="$INSTALL_PREFIX"
        --enable-gpl
        --enable-version3
        --enable-nonfree
        --enable-shared
        --disable-static
        --enable-openssl
        --enable-libsrt
        --disable-doc
        --disable-htmlpages
        --disable-manpages
        --disable-podpages
        --disable-txtpages
    )
    # Let FFmpeg auto-detect available libraries instead of forcing them
    set +e
    ./configure "${MINIMAL_OPTS[@]}"
    MINIMAL_STATUS=$?
    set -e
    if [ $MINIMAL_STATUS -ne 0 ]; then
        echo "❌ Minimal configuration also failed. Please check dependencies."
        exit 1
    fi
fi

echo ""
echo "Step 2: Building FFmpeg (this will take a while)..."
echo "Using $(nproc) parallel jobs"
echo ""

make -j$(nproc)

if [ $? -ne 0 ]; then
    echo ""
    echo "Build failed! Check the error messages above."
    exit 1
fi

echo ""
echo "Step 3: Verifying WHIP and SRT support..."
echo ""

# Check if WHIP muxer is enabled
if ./ffmpeg -muxers 2>&1 | grep -q "whip"; then
    echo "✅ WHIP muxer is enabled!"
else
    echo "⚠️  WHIP muxer not found in build"
fi

# Check if DTLS protocol is available
if ./ffmpeg -protocols 2>&1 | grep -qi "dtls"; then
    echo "✅ DTLS protocol is available!"
else
    echo "⚠️  DTLS protocol not found"
fi

# CRITICAL: Check if SRT protocol is available
if ./ffmpeg -protocols 2>&1 | grep -qi "srt"; then
    echo "✅ SRT protocol is available! (Required for this project)"
else
    echo "❌ ERROR: SRT protocol not found! This is required for the project!"
    echo "   Build may have failed to enable SRT support"
    exit 1
fi

echo ""
echo "Step 4: Installation..."
echo "This will install to $INSTALL_PREFIX"
echo "The existing wrapper script at /usr/local/bin/ffmpeg will be replaced"
echo ""
echo "Proceeding with installation (non-interactive mode)..."

sudo make install
sudo ldconfig

echo ""
echo "=========================================="
echo "Build Complete!"
echo "=========================================="
echo ""
echo "Verifying installation..."
$INSTALL_PREFIX/bin/ffmpeg -version | head -3
echo ""
echo "Checking WHIP support..."
$INSTALL_PREFIX/bin/ffmpeg -muxers 2>&1 | grep -i whip || echo "WHIP not found"
echo ""
echo "FFmpeg with WebRTC support is now installed at:"
echo "  $INSTALL_PREFIX/bin/ffmpeg"
echo ""

