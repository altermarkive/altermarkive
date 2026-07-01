use std::error::Error;
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Write};

const KDBX_HEADER_SIGNATURE_1: u32 = 0x9AA2D903;
const KDBX_HEADER_SIGNATURE_2: u32 = 0xB54BFB67;
const KDBX_HEADER_FORMAT_VERSION_4_0: u32 = 0x00040000;
const KDBX_HEADER_FORMAT_VERSION_4_1: u32 = 0x00040001;

#[derive(Debug)]
enum KdbxErrorCode {
    HeaderValidationError,
    CliPathError,
}

#[derive(Debug)]
struct KdbxError {
    code: KdbxErrorCode,
    message: String,
}

impl fmt::Display for KdbxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "[{:?}] {}", self.code, self.message)
    }
}

impl Error for KdbxError {}

#[derive(Debug)]
struct KdbxHeader {
    signature1: u32,
    signature2: u32,
    format_version: u32,
}

impl KdbxHeader {
    fn new() -> Self {
        Self {
            signature1: KDBX_HEADER_SIGNATURE_1,
            signature2: KDBX_HEADER_SIGNATURE_2,
            format_version: KDBX_HEADER_FORMAT_VERSION_4_1,
        }
    }

    fn write(&self, file: &mut impl Write) -> io::Result<()> {
        file.write_all(&self.signature1.to_le_bytes())?;
        file.write_all(&self.signature2.to_le_bytes())?;
        file.write_all(&self.format_version.to_le_bytes())?;
        Ok(())
    }

    fn read(file: &mut impl Read) -> io::Result<Self> {
        let mut signature1_bytes = [0u8; 4];
        let mut signature2_bytes = [0u8; 4];
        let mut format_version_bytes = [0u8; 4];
        file.read_exact(&mut signature1_bytes)?;
        file.read_exact(&mut signature2_bytes)?;
        file.read_exact(&mut format_version_bytes)?;
        Ok(KdbxHeader {
            signature1: u32::from_le_bytes(signature1_bytes),
            signature2: u32::from_le_bytes(signature2_bytes),
            format_version: u32::from_le_bytes(format_version_bytes),
        })
    }

    fn validate(&self) -> Result<(), KdbxError> {
        if self.signature1 != KDBX_HEADER_SIGNATURE_1 {
            return Err(KdbxError {
                code: KdbxErrorCode::HeaderValidationError,
                message: format!(
                    "KdbxHeader.signature1: found {:#010x}, expected {:#010x}",
                    self.signature1, KDBX_HEADER_SIGNATURE_1
                ),
            });
        }
        if self.signature2 != KDBX_HEADER_SIGNATURE_2 {
            return Err(KdbxError {
                code: KdbxErrorCode::HeaderValidationError,
                message: format!(
                    "KdbxHeader.signature2: found {:#010x}, expected {:#010x}",
                    self.signature2, KDBX_HEADER_SIGNATURE_2
                ),
            });
        }
        match self.format_version {
            KDBX_HEADER_FORMAT_VERSION_4_0 | KDBX_HEADER_FORMAT_VERSION_4_1 => {}
            _ => {
                return Err(KdbxError {
                    code: KdbxErrorCode::HeaderValidationError,
                    message: format!(
                        "KdbxHeader.format_version: found {:#010x}, expected {:#010x} or {:#010x}",
                        self.format_version,
                        KDBX_HEADER_FORMAT_VERSION_4_0,
                        KDBX_HEADER_FORMAT_VERSION_4_1
                    ),
                });
            }
        }
        Ok(())
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let original_path = std::env::args().nth(1).ok_or_else(|| KdbxError {
        code: KdbxErrorCode::CliPathError,
        message: "Expected a path to a KDBX file as the first argument".to_string(),
    })?;
    let mut file = File::open(&original_path)?;
    let header = KdbxHeader::read(&mut file)?;
    println!(
        "Read original KDBX file from {} header={:?} valid={:?}",
        original_path,
        header,
        header.validate()?
    );
    let backup_path = format!("{}.bak", original_path);
    let mut backup = File::create(&backup_path)?;
    KdbxHeader::new().write(&mut backup)?;
    println!("Wrote backup KDBX file to {}", backup_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_validates_header() {
        let mut file = File::open("tests/keys.kdbx").unwrap();
        let header = KdbxHeader::read(&mut file).unwrap();
        assert!(header.validate().is_ok());
    }

    #[test]
    fn writes_then_reads_and_validates_header() {
        let path =
            std::env::temp_dir().join(format!("kdbx_header_roundtrip_{}.kdbx", std::process::id()));

        let mut write_file = File::create(&path).unwrap();
        KdbxHeader::new().write(&mut write_file).unwrap();
        drop(write_file);

        let mut read_file = File::open(&path).unwrap();
        let header = KdbxHeader::read(&mut read_file).unwrap();
        assert!(header.validate().is_ok());

        std::fs::remove_file(&path).unwrap();
    }
}
