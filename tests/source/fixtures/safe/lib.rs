use near_sdk::near;

#[near(contract_state)]
pub struct SafeContract {
    value: u64,
    }

    #[near]
    impl SafeContract {
        pub fn get_value(&self) -> u64 {
                self.value
                    }
                    }
                    